#!/usr/bin/env node
// scripts/contest-stress.mjs
// Isolated end-to-end stress test of the church dish contest.
//
//   node scripts/contest-stress.mjs [--dishes 45] [--voters 100] [--minutes 4] [--port 4250]
//        [--report <path>] [--keep]
//
// It NEVER touches the real contest. It forks its own copy of the contest app (this same file,
// run in an internal `--harness <dir> <port>` mode) on 127.0.0.1:<port>, with a throwaway data
// directory made by fs.mkdtempSync under the OS temp dir, and deletes that directory at the end
// unless --keep. There is no option to point it at a directory, and --port 4242 (the dashboard)
// is refused.
//
// The harness child sets SEO_CLAUDE_ROOT to a sandbox inside the temp dir BEFORE importing the
// route module, because that module builds a default instance at import time: it mkdirs
// <ROOT>/data/.uploads-tmp and creates a (lazy) store for <ROOT>/data/contest. The store reads
// nothing until a request reaches it, but the mkdir is real, so the override keeps even that
// inside the temp dir.
//
// Phases: A setup + submissions, B browse, C voting, D deadline, E tally, F reveal,
// G restart persistence, H report. Every check is PASS/FAIL; exit 1 if any fails.
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SCRIPT), '..');
const PUBLIC_DIR = join(ROOT, 'agents', 'dashboard', 'public', 'contest');
const DASHBOARD_PORT = 4242;
const PHONE_IP = '203.0.113.10';
const COOK_IPS = [11, 23, 37, 42, 58, 76].map((n) => `198.51.100.${n}`);
const CATEGORY_NAMES = ['Main', 'Appetizer', 'Dessert', 'Side Dish'];
const SEED = 20261126;

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const sleepUntil = (t) => sleep(t - Date.now());

// ---- seeded PRNG (no Math.random for content or behaviour) ------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rnd) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function uuidFrom(rnd) {
  const b = Array.from({ length: 16 }, () => Math.floor(rnd() * 256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---- content ----------------------------------------------------------------

/** Allergens derived from the ingredient text, so they can never disagree with it. */
const ALLERGEN_RULES = [
  ['milk', /\b(butter|milk|cream|cheese|cheddar|parmesan|mozzarella|gruy[eè]re|brie|yogurt|buttermilk|half-and-half|ricotta|mascarpone|ghee|pepper jack|monterey jack|velveeta)\b/],
  ['eggs', /\b(eggs?|yolks?|mayonnaise|mayo)\b/],
  ['fish', /\b(anchov(y|ies)|fish sauce|worcestershire|salmon|tuna)\b/],
  ['shellfish', /\b(shrimp|crab|crabmeat|oysters?|lobster|crawfish|clams?|scallops?)\b/],
  ['tree-nuts', /\b(pecans?|walnuts?|almonds?|cashews?|pistachios?|hazelnuts?)\b/],
  ['peanuts', /\bpeanuts?\b/],
  ['wheat', /\b(flour|bread|breadcrumbs|panko|rolls?|pasta|macaroni|elbows|crackers?|pie crust|puff pastry|graham|biscuits?|croutons|crescent|phyllo|noodles|soy sauce|hoisin|cake mix|muffin mix|cookies?|wonton|dumpling wrappers|vanilla wafers|baguette|crostini|stuffing cubes|ladyfingers)\b/],
  ['soy', /\b(soy sauce|tofu|edamame|miso|hoisin)\b/],
  ['sesame', /\b(sesame|tahini)\b/],
  ['citrus', /\b(lemons?|limes?|oranges?|grapefruit|clementines?|tangerines?)\b/],
];
// Words that contain an allergen keyword without containing the allergen.
const ALLERGEN_FALSE_FRIENDS = /\b(peanut butter|butternut|coconut milk|coconut cream|cream of tartar|eggplant|apple butter|almond extract)\b/g;

function deriveAllergens(ingredients) {
  const text = ingredients.toLowerCase();
  const stripped = text.replace(ALLERGEN_FALSE_FRIENDS, ' ');
  const found = new Set();
  for (const [name, re] of ALLERGEN_RULES) {
    const src = name === 'peanuts' ? text : stripped;
    if (re.test(src)) found.add(name);
  }
  if (/peanut butter/.test(text)) found.add('peanuts');
  if (/almond extract/.test(text)) found.add('tree-nuts');
  return found.size ? [...found] : ['none'];
}

const LONG_NOTES = [
  'Thaw a frozen turkey in the refrigerator, allowing about one day for every four to five pounds. A 20 pound bird needs four to five full days, so pull it out of the freezer the weekend before. Never thaw on the counter; the outside warms into the danger zone long before the center softens.',
  'Pull the turkey out of the refrigerator one hour before it goes in. A cold bird cooks unevenly, with the breast drying out while the thighs are still catching up. Pat it completely dry with paper towels, inside and out, because a dry skin is the whole secret to a crisp one.',
  'Use an instant-read thermometer in three places: the thickest part of the breast, the thickest part of the thigh without touching bone, and the center of the stuffing if you cooked it inside the bird. Breast at 160 degrees and thigh at 175 will both climb another five degrees while resting.',
  'Rest the turkey at least 30 minutes, tented loosely with foil, before carving. The juices settle back into the meat instead of running all over the board. Use the resting time to make gravy, warm the rolls and get the casseroles back in the oven for a final ten minutes.',
  'Carve the whole bird in the kitchen rather than at the table. Remove each breast in one piece, then slice it across the grain about half an inch thick. Separate the drumsticks and thighs at the joint, and set the wings aside for whoever always asks for them.',
  'Save the carcass. Cover it with water, add an onion, a carrot, a rib of celery and a bay leaf, and simmer it gently for three hours on Friday. Strain it and you have the base for turkey and rice soup, turkey pot pie, or next year\'s gravy kept in the freezer.',
  'Leftovers need to be in the refrigerator within two hours of coming off the heat. Pull the meat off the bones before storing, because a whole carcass takes far too long to cool in the middle. Shallow containers cool faster than one big pot.',
  'If you are transporting the dish to the church, wrap the hot pan in two layers of foil and then a thick bath towel, and set it in a cooler with no ice. It will stay hot for well over an hour, which covers the drive and the wait before the blessing.',
  'Label the dish with your name and the main allergens on a strip of masking tape across the lid. People with nut and dairy allergies will thank you, and it makes it much easier to get your pan back at the end of the night instead of hunting through the kitchen.',
  'Make a double batch if you can. Every year somebody brings a store-bought tray at the last minute and the homemade dishes go first. A second pan kept warm in the kitchen is the difference between seconds for everyone and a scraped-clean dish by the third table.',
  'Write the recipe down while it is fresh. Half the family recipes in this congregation exist only in somebody\'s head, and every year someone asks how a dish was made. A card tucked under the pan is the nicest gift you can leave on the potluck table.',
  'Salt in stages rather than all at the end. A pinch with the onions, a pinch when the liquid goes in and a final taste just before serving builds flavour all the way through instead of leaving the outside salty and the middle bland.',
  'Clean as you go and soak the roasting pan right away. The browned bits stuck to the bottom are the best part of the gravy, so scrape them up with a splash of broth first, and only then fill the pan with hot soapy water to soak overnight.',
  'Give the oven a full twenty minutes to preheat. Most home ovens report that they are ready long before the walls have actually come up to temperature, and a casserole that goes into a lukewarm oven ends up soggy on the bottom and pale on top.',
  'Keep a small bowl of the dish back at home for the cook. By the time the contest is over and the tables are cleared, there is rarely any left, and it is a shame to have spent all morning cooking and never had a single bite of your own entry.',
  'Taste the drippings before you season the gravy. A brined or injected bird gives off salty juices, and a gravy seasoned by habit on top of that can turn inedible in one pinch. Add the salt last, a little at a time, after the gravy has thickened and reduced to the consistency you want.',
  'A roasting pan that is too big lets the drippings spread thin and scorch before the bird is done. Choose a pan only a couple of inches wider than the turkey, and if the bottom starts to look dark and dry, add half a cup of broth or water so there is something left to make gravy with.',
  'Do not rinse the raw turkey in the sink. It does nothing for food safety and sprays bacteria across the counter and the dish rack. If you brined it, lift it out, let it drain, and pat it dry with paper towels that go straight into the trash.',
  'Write down the time the dish went into the oven and the time you expect it out, on a sticky note on the oven door. On a busy morning with four dishes going at once and family arriving, that note has saved more than one turkey from an extra hour in the oven.',
  'Check the weather the night before. If it is going to be warm, plan to keep cold dishes on ice at the church, and bring a cooler for anything with mayonnaise, cream or eggs. Two hours on a warm table is the limit for anything perishable.',
  'Ask for help carrying a full roasting pan. A 20 pound turkey plus a pan of hot drippings is heavy and awkward, and the parking lot slopes toward the side door. Two people and a sturdy board make the trip from the car safe for the cook and for the dinner.',
  'If it rains on the day, bring the dish in through the side door by the fellowship hall kitchen. The ovens there run hot, about 25 degrees above what the dial says, so if you need to reheat, set it lower than you would at home and check it early.',
];

function steps(lines) {
  return lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
}

/**
 * A long recipe: detailed steps plus hand-written notes, filled sentence by sentence to just
 * under the 8,000-char cap the way the recipe import fills it. With ~30 line breaks it is
 * OVER 8,000 once a browser sends those breaks as CRLF, which is the case that once failed.
 */
function longRecipe(stepLines, noteOffset) {
  const CAP = 8000;
  const sentences = [];
  for (let i = 0; i < LONG_NOTES.length; i++) {
    sentences.push(...(LONG_NOTES[(i + noteOffset) % LONG_NOTES.length].match(/[^.!?]+[.!?]+/g) || []).map((x) => x.trim()));
  }
  let text = `${steps(stepLines)}\n\nNotes:`;
  for (const sentence of sentences) {
    if ((text + `\n- ${sentence}`).length <= CAP) { text += `\n- ${sentence}`; continue; }
    // Last line: as many whole words as still fit, the way a cook trims to the counter.
    let partial = '';
    for (const word of sentence.split(' ')) {
      const next = partial ? `${partial} ${word}` : word;
      if ((text + `\n- ${next}`).length > CAP) break;
      partial = next;
    }
    if (partial) text += `\n- ${partial}`;
    break;
  }
  return text;
}

const D = (category, cook, name, ingredients, recipeLines, long = null) => {
  const ing = ingredients.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  const st = recipeLines.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  return {
    category,
    cook,
    name,
    ingredients: ing.join('\n'),
    ingredientCount: ing.length,
    stepCount: st.length,
    recipe: long === null ? steps(st) : longRecipe(st, long),
    allergens: deriveAllergens(ing.join('\n')),
  };
};

const DISHES = [
  // ---- Main --------------------------------------------------------------
  D('Main', 'Earl Washington', 'Hickory-Smoked Whole Turkey', `
    1 whole turkey, 14 to 16 lb, thawed
    1 gallon water for the brine
    1 cup kosher salt
    1/2 cup dark brown sugar
    2 tbsp black peppercorns
    4 bay leaves
    1 head garlic, halved
    2 tbsp smoked paprika
    1 tbsp garlic powder
    1 tbsp onion powder
    1 stick unsalted butter, melted
    4 cups hickory wood chunks`, `
    The night before, dissolve the salt and brown sugar in one quart of hot water with the peppercorns, bay leaves and garlic, then add the rest of the water cold so the brine is completely cool before the turkey goes in. Submerge the bird breast side down in a brining bag inside a cooler, cover it with ice, and leave it for 12 to 16 hours, turning it once if you wake up in the night.
    In the morning, lift the turkey out of the brine, rinse it inside and out under cold water, and pat it as dry as you possibly can. Set it on a rack over a sheet pan in the refrigerator, uncovered, for at least two hours so the skin dries out; this is the step that keeps smoked turkey skin from turning rubbery.
    Light the smoker and bring it to a steady 275 degrees. Soak nothing; dry hickory chunks give a cleaner smoke than wet ones, and you want thin blue smoke coming out of the stack, never thick white billows, which make the meat bitter.
    Mix the smoked paprika, garlic powder, onion powder and a teaspoon of black pepper. There is plenty of salt already in the meat from the brine, so leave salt out of the rub entirely or the drippings will be too salty to use for gravy.
    Brush the whole bird with half of the melted butter, then season it evenly all over with the rub, including under the wings and inside the cavity. Tuck the wing tips behind the back so they do not burn, and tie the legs loosely with kitchen twine.
    Set the turkey on the grate breast side up with the legs pointing toward the firebox, since the dark meat can take the extra heat. Close the lid and leave it alone for the first two hours; every time the lid comes up you lose heat and add twenty minutes to the cook.
    Add two or three chunks of hickory every 45 minutes for the first three hours only. After that the meat has taken on all the smoke it will absorb, and more wood only darkens the skin without adding flavour.
    At the three hour mark, baste the turkey with the rest of the melted butter and start checking the temperature. Plan on roughly 30 minutes per pound at 275 degrees, but cook to temperature, not time: 160 in the breast and 175 in the thigh.
    When it is done, move the turkey to a clean board, tent it loosely with foil and rest it for at least 45 minutes. Smoked turkey holds its heat beautifully, so this rest is a gift when the rest of the meal is running late.
    Carve the breast off in whole lobes and slice it across the grain, then separate the legs and thighs. Arrange everything on a warm platter with the pink smoke ring showing and spoon a little of the drippings over the top just before serving.`, 0),
  D('Main', 'Darnell Broussard', 'Cajun Deep-Fried Turkey', `
    1 whole turkey, 12 lb, thawed and dried
    3 gallons peanut oil
    1/2 cup Cajun seasoning
    1/2 cup melted butter
    2 tbsp hot sauce
    1 tbsp garlic powder
    1 tsp cayenne pepper`, `
    Measure the oil level first: put the raw turkey in the empty pot, cover it with water, lift the bird out and mark the water line. Dry the pot completely.
    Whisk the melted butter, hot sauce, garlic powder and half the Cajun seasoning and inject it deep into the breasts, thighs and drumsticks.
    Rub the remaining seasoning all over the outside and let the bird sit at room temperature for 30 minutes.
    Set the fryer on flat dirt or concrete, well away from the house, and heat the oil to 350°F.
    Turn the burner off, then lower the turkey into the oil very slowly on the hook. Relight and hold the oil around 325°F.
    Fry for 3 1/2 minutes per pound, until the breast reads 160°F and the thigh 175°F.
    Lift it out slowly, drain on a rack and rest 20 minutes before carving.`),
  D('Main', 'Margaret Ellison', 'Herb-Butter Roasted Turkey', `
    1 whole turkey, 18 lb
    2 sticks unsalted butter, softened
    2 tbsp fresh sage, chopped
    2 tbsp fresh thyme leaves
    1 tbsp fresh rosemary, chopped
    4 cloves garlic, minced
    1 onion, quartered
    2 carrots, cut in chunks
    2 ribs celery
    2 cups chicken broth
    Salt and black pepper`, `
    Heat the oven to 325°F and set a rack in the lowest position.
    Mash the butter with the sage, thyme, rosemary, garlic, two teaspoons salt and a teaspoon of pepper.
    Loosen the skin over the breast and thighs with your fingers and push most of the herb butter underneath. Rub the rest over the skin.
    Stuff the cavity with the onion, then scatter the carrots and celery in the roasting pan with the broth and set the turkey on top.
    Roast about 13 minutes per pound, basting every 45 minutes, and tent the breast with foil once it is deep golden.
    Rest 30 minutes before carving and use the pan juices for gravy.`),
  D('Main', 'Linda Okafor', 'Spatchcocked Citrus Turkey', `
    1 whole turkey, 12 lb
    2 oranges, zested and juiced
    2 lemons, zested and juiced
    1/4 cup olive oil
    6 cloves garlic, smashed
    2 tbsp kosher salt
    1 tbsp fresh oregano
    1 tsp red pepper flakes`, `
    Cut out the backbone with poultry shears, flip the turkey and press down hard on the breastbone until it lies flat.
    Rub the salt and citrus zest all over and refrigerate uncovered overnight.
    Heat the oven to 450°F. Whisk the citrus juices, olive oil, garlic, oregano and pepper flakes.
    Lay the turkey skin side up on a rack over a sheet pan and brush with half the citrus mixture.
    Roast 70 to 80 minutes, brushing once more halfway, until the breast reaches 160°F.
    Rest 20 minutes and carve.`),
  D('Main', 'Tom Kowalski', 'Bacon-Wrapped Turkey Breast', `
    1 boneless turkey breast, about 4 lb
    1 lb thick-cut bacon
    2 tbsp brown sugar
    1 tbsp Dijon mustard
    1 tsp dried thyme
    1 tsp black pepper`, `
    Heat the oven to 375°F.
    Brush the turkey breast with the mustard and season with thyme and pepper.
    Lay the bacon slices side by side in a woven lattice and roll the breast up inside it, seam side down.
    Sprinkle the brown sugar over the top and roast on a rack for about 90 minutes, until the center reads 160°F.
    Rest 15 minutes, then slice thick so every piece keeps its bacon.`),
  D('Main', 'Ruth Abernathy', 'Maple-Bourbon Glazed Ham', `
    1 bone-in smoked ham, 9 lb
    1 cup pure maple syrup
    1/3 cup bourbon
    1/4 cup Dijon mustard
    1/4 cup brown sugar
    1/2 tsp ground cloves
    1 cup apple cider`, `
    Heat the oven to 325°F. Score the ham in a diamond pattern about a quarter inch deep.
    Set it in a roasting pan with the apple cider, cover tightly with foil and bake 2 hours.
    Simmer the maple syrup, bourbon, mustard, brown sugar and cloves for 5 minutes until syrupy.
    Uncover the ham, raise the oven to 400°F and brush with the glaze every 10 minutes for 30 minutes.
    Rest 20 minutes before slicing.`),
  D('Main', 'José Martínez', "Abuela's Pavo Relleno 🦃", `
    1 whole turkey, 14 lb
    1 lb ground pork
    1/2 cup raisins
    1/2 cup green olives, chopped
    1/2 cup almonds, slivered
    2 plantains, diced
    1 onion, diced
    3 tomatoes, chopped
    4 cloves garlic
    1 tbsp achiote paste
    1 orange, juiced
    1 tsp ground cumin
    Salt and pepper`, `
    Blend the achiote paste, orange juice, two cloves garlic, cumin and salt into a marinade and rub it all over the turkey. Refrigerate overnight.
    Brown the pork with the onion and remaining garlic, then add the tomatoes and simmer 10 minutes.
    Stir in the plantains, raisins, olives and almonds and cook until the plantains soften. Cool completely.
    Heat the oven to 325°F. Fill the cavity loosely with the relleno and tie the legs.
    Roast about 15 minutes per pound, basting with the pan juices, until the thigh reads 175°F and the stuffing 165°F.
    Rest 30 minutes. ¡Buen provecho!`),
  D('Main', 'Zoë Lefèvre', 'Turkey Roulade with Spinach and Gruyère', `
    1 boneless turkey breast, butterflied, 3 lb
    5 oz baby spinach
    1 cup Gruyère, grated
    1/2 cup panko breadcrumbs
    2 shallots, minced
    2 tbsp butter
    1 tbsp fresh thyme
    Salt and pepper`, `
    Pound the butterflied breast to an even 3/4 inch thickness between two sheets of plastic wrap.
    Sauté the shallots in the butter, add the spinach until wilted, and squeeze out all the liquid.
    Mix the spinach with the Gruyère, panko and thyme and spread it over the turkey, leaving a one inch border.
    Roll it up tightly from the long side and tie at two inch intervals with twine.
    Sear on all sides in an oven-safe skillet, then roast at 375°F for 50 to 60 minutes until it reaches 160°F.
    Rest 15 minutes, remove the twine and slice into rounds.`),
  D('Main', 'Marcus Bell', 'Smoked Turkey Legs', `
    6 turkey drumsticks
    1/4 cup kosher salt
    1/4 cup brown sugar
    2 tbsp smoked paprika
    1 tbsp black pepper
    1 tbsp garlic powder
    1 tsp cayenne`, `
    Dissolve the salt and sugar in two quarts of water, add the drumsticks and brine 8 hours.
    Rinse, pat dry and coat with the paprika, pepper, garlic powder and cayenne.
    Smoke at 250°F over apple wood for 3 to 4 hours, until the meat reaches 180°F and pulls back from the bone.
    Rest 10 minutes and serve fair-style, one leg per hungry person.`),
  D('Main', 'Gloria Santos', 'Honey-Glazed Spiral Ham', `
    1 spiral-cut ham, 8 lb
    1/2 cup honey
    1/2 cup brown sugar
    1/4 cup butter
    1/2 tsp cinnamon
    1/4 tsp ground cloves
    1 cup pineapple juice`, `
    Heat the oven to 275°F. Set the ham cut side down in a pan with the pineapple juice and wrap tightly in foil.
    Bake 10 minutes per pound until warmed through.
    Melt the butter with the honey, brown sugar, cinnamon and cloves.
    Uncover the ham, brush the glaze between the slices, and bake at 400°F for 10 minutes until it bubbles.`),
  D('Main', 'Pastor Dale Henderson', 'Brined Turkey with Apple Cider Gravy', `
    1 whole turkey, 16 lb
    1 gallon apple cider
    1 cup kosher salt
    2 apples, quartered
    1 onion, quartered
    4 tbsp butter
    1/4 cup all-purpose flour
    2 cups turkey stock
    1 tbsp apple cider vinegar
    4 sprigs fresh sage`, `
    Simmer half the cider with the salt until dissolved, add the remaining cider cold, and brine the turkey 18 hours.
    Rinse and dry the turkey, stuff with the apples, onion and sage, and rub with two tablespoons of the butter.
    Roast at 325°F until the thigh reads 175°F, about 3 1/2 hours.
    Skim the fat from the drippings. Cook the remaining butter and flour until golden, whisk in the drippings, stock and a splash of cider.
    Simmer until thick, finish with the vinegar and season.
    Carve the turkey and pass the gravy.`),
  D('Main', 'Becky Lindqvist', 'Slow-Cooker Turkey Breast', `
    1 bone-in turkey breast, 6 lb
    1 packet onion soup mix
    4 tbsp butter, softened
    1 tsp dried rosemary
    1/2 cup chicken broth`, `
    Mix the butter with the soup mix and rosemary and rub it over and under the skin.
    Pour the broth into the slow cooker and set the breast on top, skin side up.
    Cook on low 6 to 7 hours, until it reads 160°F.
    Broil the skin for 5 minutes to crisp it, then rest and slice.`),
  D('Main', 'Frank Delgado', 'Prime Rib Roast', `
    1 standing rib roast, 3 bones, about 7 lb
    3 tbsp kosher salt
    1 tbsp cracked black pepper
    6 cloves garlic, minced
    2 tbsp fresh rosemary
    3 tbsp olive oil
    1 tbsp prepared horseradish
    1/2 cup sour cream`, `
    Salt the roast all over two days ahead and leave it uncovered in the refrigerator.
    Bring it to room temperature for two hours. Rub with the garlic, rosemary, pepper and oil.
    Roast at 225°F until the center reads 120°F, about 4 hours.
    Rest 30 minutes, then blast at 500°F for 8 minutes to brown the crust.
    Stir the horseradish into the sour cream and serve alongside thick slices.`),
  D('Main', 'Annie McAllister', 'Turkey Pot Pie', `
    3 cups cooked turkey, diced
    1 cup frozen peas
    2 carrots, diced
    2 ribs celery, diced
    1 onion, diced
    1/3 cup butter
    1/3 cup all-purpose flour
    2 cups chicken broth
    2/3 cup milk
    2 refrigerated pie crusts
    1 egg, beaten`, `
    Heat the oven to 425°F.
    Melt the butter and cook the onion, carrots and celery until soft.
    Stir in the flour, then the broth and milk, and simmer until thick.
    Fold in the turkey and peas and season well.
    Line a deep dish with one crust, fill, top with the second crust and crimp. Cut vents and brush with egg.
    Bake 35 minutes until golden, then rest 15 minutes before cutting.`),
  D('Main', 'Desmond Clarke', 'Jerk-Spiced Turkey', `
    1 turkey breast, bone-in, 5 lb
    4 scallions
    2 Scotch bonnet peppers
    1 tbsp allspice berries
    1 tbsp fresh thyme
    4 cloves garlic
    2 tbsp brown sugar
    2 limes, juiced
    3 tbsp vegetable oil
    1 tsp cinnamon`, `
    Blend the scallions, peppers, allspice, thyme, garlic, sugar, lime juice, oil and cinnamon into a paste. Wear gloves.
    Rub the paste over and under the skin and marinate overnight.
    Grill over indirect medium heat, lid closed, until the breast reaches 160°F, about 90 minutes.
    Rest 15 minutes and slice.`),
  D('Main', 'Kevin Nguyen', 'Sous Vide Turkey Breast', `
    1 boneless turkey breast, skin on, 3 lb
    1 tbsp kosher salt
    1 tsp black pepper
    4 sprigs fresh thyme
    2 tbsp butter
    2 tbsp vegetable oil`, `
    Season the breast with salt and pepper and bag it with the thyme and butter.
    Cook in a 145°F water bath for 4 hours.
    Pat the skin completely dry and sear skin side down in hot oil until deep brown and crisp.
    Rest 5 minutes and slice; it will be juicy all the way through.`),
  D('Main', 'Grace Lin', 'Peking-Style Duck', `
    1 whole duck, 5 lb
    2 tbsp hoisin sauce
    2 tbsp soy sauce
    2 tbsp honey
    1 tsp five-spice powder
    1 tbsp toasted sesame oil
    4 scallions
    12 mandarin pancakes`, `
    Pour boiling water over the duck to tighten the skin, then dry it uncovered in the refrigerator for 24 hours.
    Rub the cavity with five-spice and stuff with the scallions.
    Roast breast side up at 350°F for 90 minutes, pouring off the fat twice.
    Mix the hoisin, soy, honey and sesame oil and brush it on for the last 15 minutes at 425°F.
    Carve thin and serve with the pancakes and extra hoisin.`),
  D('Main', 'Ida Mae Prescott', 'Pecan-Crusted Turkey Cutlets', `
    2 lb turkey breast cutlets
    1 1/2 cups pecans, finely chopped
    1/2 cup panko breadcrumbs
    1/2 cup all-purpose flour
    2 eggs
    2 tbsp Dijon mustard
    1/4 cup vegetable oil
    Salt and pepper`, `
    Season the cutlets. Set out the flour, the eggs whisked with the mustard, and the pecans mixed with panko.
    Dredge each cutlet in flour, egg, then the pecan crumbs, pressing to coat.
    Pan-fry in the oil over medium heat 3 minutes per side until golden and cooked through.
    Drain on a rack and keep warm in a 200°F oven until serving.`),

  // ---- Side Dish -----------------------------------------------------------
  D('Side Dish', 'Hattie Johnson', "Grandma's Cornbread Dressing", `
    2 cups yellow cornmeal
    1 cup all-purpose flour
    2 cups buttermilk
    3 eggs
    1 stick butter
    1 large onion, diced
    4 ribs celery, diced
    1 green bell pepper, diced
    4 cups chicken broth
    2 tsp rubbed sage
    1 tsp poultry seasoning
    1 tsp black pepper`, `
    Make the cornbread a day ahead. Heat a cast iron skillet with two tablespoons of the butter in a 425°F oven until the butter is sizzling. Whisk the cornmeal, flour, a teaspoon of salt and two teaspoons of baking powder, then stir in the buttermilk and one egg until just combined, pour it into the hot skillet and bake 20 to 25 minutes until golden and pulling away from the sides.
    Crumble the cooled cornbread into a very large bowl and leave it out uncovered overnight. Day-old, slightly dry cornbread soaks up the broth without turning to mush, which is the difference between a dressing that holds a spoon line and one that slumps.
    The next morning, melt the rest of the butter in a wide skillet and cook the onion, celery and bell pepper slowly over medium heat for 12 to 15 minutes, until completely soft and sweet but not browned. Season with the sage, poultry seasoning and black pepper in the last minute so the dried herbs wake up in the fat.
    Scrape the vegetables and every bit of butter over the crumbled cornbread and toss with your hands until evenly mixed. Taste a pinch now: this is your last chance to adjust the sage, and Grandma always said it should taste a little too strong at this stage because the broth softens it.
    Warm the chicken broth and pour it over gradually, folding as you go, until the mixture is wet like a thick oatmeal. You may not need all four cups if your cornbread was moist, and you may need a splash more if it was very dry. Beat the remaining two eggs and fold them in last to bind it.
    Butter a 9 by 13 inch baking dish and spread the dressing in evenly without packing it down. Pressing it makes it dense; you want it level but loose so the heat moves through it and the top can form a crust.
    Bake uncovered at 350°F for 45 to 55 minutes, until the top is deep golden brown, the edges are crisp and a knife in the center comes out moist but not wet. If the top colours too fast, lay a sheet of foil loosely over it for the last 15 minutes.
    Let it stand ten minutes before serving so it sets enough to scoop cleanly. Serve with plenty of turkey gravy and a spoonful of cranberry sauce on the side, the way it has been served at this table every year.`, 5),
  D('Side Dish', 'Bill Thornton', 'Sausage and Sage Stuffing', `
    1 loaf crusty white bread, cubed and dried
    1 lb breakfast sausage
    1 stick butter
    1 onion, diced
    3 ribs celery, diced
    2 tbsp fresh sage
    2 eggs
    3 cups chicken broth`, `
    Brown the sausage, breaking it up, and remove it to the bread bowl.
    Melt the butter in the drippings and cook the onion and celery until soft. Add the sage.
    Toss everything with the bread, then the eggs beaten into the broth.
    Bake covered at 350°F for 30 minutes, then uncovered 20 more until crisp on top.`),
  D('Side Dish', 'Clarence Fontenot', 'Oyster Dressing', `
    1 pint shucked oysters with their liquor
    6 cups day-old French bread, cubed
    1 stick butter
    1 onion, diced
    2 ribs celery, diced
    1/2 green bell pepper, diced
    3 green onions, sliced
    1/4 cup fresh parsley
    1 tsp Creole seasoning
    1 cup chicken stock`, `
    Drain the oysters, saving the liquor, and chop them roughly.
    Cook the onion, celery and bell pepper in the butter until soft.
    Add the oysters and cook just until their edges curl.
    Fold in the bread, green onions, parsley, seasoning, the oyster liquor and enough stock to moisten.
    Bake uncovered at 350°F for 35 minutes until browned.`),
  D('Side Dish', 'Shirley Robinson', 'Baked Mac and Cheese', `
    1 lb elbow macaroni
    4 cups sharp cheddar, shredded
    2 cups Monterey Jack, shredded
    1 can evaporated milk
    1 cup whole milk
    2 eggs
    1/2 stick butter, melted
    1 tsp dry mustard
    1/2 tsp smoked paprika
    Salt and pepper`, `
    Heat the oven to 350°F. Boil the macaroni two minutes short of done and drain.
    Whisk the evaporated milk, milk, eggs, butter, mustard, salt and pepper.
    Layer the macaroni with most of the cheese in a buttered dish, pour the custard over, and top with the rest of the cheese and the paprika.
    Bake 40 minutes until bubbling and browned at the edges. Rest 15 minutes so it slices clean.`),
  D('Side Dish', 'Tasha Greene', 'Five-Cheese Macaroni', `
    1 lb cavatappi pasta
    1/4 cup butter
    1/4 cup all-purpose flour
    3 cups whole milk
    2 cups sharp cheddar
    1 cup Gruyère
    1 cup mozzarella
    1/2 cup parmesan
    4 oz cream cheese
    1 cup panko`, `
    Cook the pasta al dente and drain.
    Make a roux with the butter and flour, whisk in the milk and simmer until thick.
    Melt in the cream cheese, cheddar, Gruyère and mozzarella off the heat.
    Fold in the pasta, pour into a dish and top with panko and parmesan.
    Bake at 375°F for 25 minutes until golden.`),
  D('Side Dish', 'Carol Peterson', 'Green Bean Casserole', `
    2 lb fresh green beans, trimmed
    2 tbsp butter
    8 oz cremini mushrooms, sliced
    2 cloves garlic
    2 tbsp all-purpose flour
    1 cup chicken broth
    1 cup half-and-half
    1 1/2 cups crispy fried onions`, `
    Blanch the beans 4 minutes, then plunge into ice water and drain.
    Sauté the mushrooms and garlic in butter, sprinkle with flour, and stir in the broth and half-and-half until thick.
    Toss with the beans and half the onions in a baking dish.
    Bake at 375°F for 25 minutes, top with the remaining onions and bake 5 more.`),
  D('Side Dish', 'Dorothy Mae Wilkins', 'Sweet Potato Casserole with Pecan Streusel', `
    4 lb sweet potatoes
    1/2 cup sugar
    2 eggs
    1/2 cup milk
    1/3 cup butter, melted
    1 tsp vanilla
    1 cup brown sugar
    1/3 cup all-purpose flour
    1 cup pecans, chopped
    1/3 cup cold butter`, `
    Roast the sweet potatoes at 400°F until soft, about an hour. Peel and mash.
    Beat in the sugar, eggs, milk, melted butter and vanilla and spread in a buttered dish.
    Rub the brown sugar, flour and cold butter together, then mix in the pecans.
    Scatter the streusel over the top and bake at 350°F for 30 minutes.`),
  D('Side Dish', 'Bernice Coleman', 'Candied Yams', `
    5 medium yams, peeled and sliced
    1 stick butter
    1 cup brown sugar
    1/4 cup white sugar
    1 tsp cinnamon
    1/2 tsp nutmeg
    1 tsp vanilla`, `
    Heat the oven to 375°F and layer the yam slices in a baking dish.
    Melt the butter with both sugars and the spices until syrupy, then add the vanilla.
    Pour over the yams, cover with foil and bake 40 minutes.
    Uncover and baste, then bake 20 minutes more until the syrup is thick and glossy.`),
  D('Side Dish', 'Steve Andersen', 'Garlic Mashed Potatoes', `
    5 lb Yukon Gold potatoes
    1 head garlic
    1 stick butter
    1 cup half-and-half
    1/2 cup sour cream
    Salt and white pepper
    2 tbsp chives`, `
    Roast the garlic head wrapped in foil at 400°F for 40 minutes.
    Boil the peeled potatoes in salted water until tender and drain well.
    Warm the butter and half-and-half, squeeze in the roasted garlic and mash with the potatoes.
    Fold in the sour cream, season and top with chives.`),
  D('Side Dish', 'Jenny Pruitt', 'Loaded Mashed Potato Casserole', `
    4 lb russet potatoes
    8 oz cream cheese
    1 cup sour cream
    1/2 cup butter
    2 cups cheddar, shredded
    8 slices bacon, cooked and crumbled
    4 green onions, sliced`, `
    Boil and mash the potatoes with the cream cheese, sour cream and butter.
    Spread in a baking dish and top with the cheddar and bacon.
    Bake at 350°F for 30 minutes and finish with the green onions.`),
  D('Side Dish', 'Eleanor Whitfield', 'Homemade Cranberry Sauce', `
    12 oz fresh cranberries
    1 cup sugar
    1 orange, zested and juiced
    1/2 cup water
    1 cinnamon stick`, `
    Bring the sugar, orange juice, water and cinnamon to a boil.
    Add the cranberries and simmer about 10 minutes, until most have popped.
    Stir in the zest, remove the cinnamon and chill until set.`),
  D('Side Dish', 'Rosa Gutiérrez', 'Cranberry-Jalapeño Relish', `
    12 oz fresh cranberries
    2 jalapeños, seeded
    1/2 cup cilantro
    1/2 cup sugar
    1 lime, juiced
    1/4 red onion
    Pinch of salt`, `
    Pulse the cranberries, jalapeños, onion and cilantro in a food processor until finely chopped.
    Stir in the sugar, lime juice and salt.
    Refrigerate at least 4 hours so the sugar dissolves. ¡Pica un poquito!`),
  D('Side Dish', 'Willie Mae Turner', 'Southern Collard Greens', `
    4 lb collard greens, stemmed and sliced
    2 smoked turkey wings
    1 onion, diced
    4 cloves garlic
    6 cups chicken broth
    2 tbsp apple cider vinegar
    1 tbsp sugar
    1 tsp red pepper flakes`, `
    Simmer the turkey wings in the broth with the onion and garlic for one hour.
    Add the greens a handful at a time as they wilt.
    Stir in the vinegar, sugar and pepper flakes and simmer 90 minutes until silky.
    Pull the meat from the wings back into the pot and serve with the pot liquor.`),
  D('Side Dish', 'Priya Raman', 'Brussels Sprouts with Bacon and Balsamic', `
    2 lb Brussels sprouts, halved
    6 slices bacon, chopped
    2 tbsp olive oil
    3 tbsp balsamic glaze
    Salt and pepper`, `
    Heat the oven to 425°F.
    Toss the sprouts with the olive oil, salt and pepper and spread cut side down on a sheet pan with the bacon.
    Roast 25 to 30 minutes until deeply browned.
    Drizzle with the balsamic glaze just before serving.`),
  D('Side Dish', 'Natalie Brooks', 'Honey-Roasted Carrots', `
    2 lb rainbow carrots
    3 tbsp olive oil
    2 tbsp honey
    1 tsp fresh thyme
    Flaky salt`, `
    Heat the oven to 400°F.
    Toss the carrots with the oil, honey and thyme.
    Roast 30 minutes, turning once, until caramelized. Finish with flaky salt.`),
  D('Side Dish', 'Harold Jensen', 'Creamed Corn', `
    8 ears sweet corn, kernels cut off
    4 tbsp butter
    1 cup heavy cream
    1 tbsp sugar
    2 tbsp all-purpose flour
    Salt and pepper`, `
    Melt the butter and add the corn, scraping in the milky pulp from the cobs.
    Whisk the flour into the cream with the sugar and pour it over the corn.
    Simmer 10 minutes, stirring, until thick and sweet. Season to taste.`),
  D('Side Dish', 'Lottie Simmons', 'Corn Pudding', `
    1 can creamed corn
    1 can whole kernel corn, drained
    1 box corn muffin mix
    1 cup sour cream
    1 stick butter, melted
    2 eggs`, `
    Heat the oven to 350°F.
    Stir everything together until just combined.
    Pour into a buttered dish and bake 45 minutes until set and golden.`),
  D('Side Dish', 'Faye Holloway', 'Squash Casserole', `
    3 lb yellow squash, sliced
    1 onion, diced
    1 cup cheddar, shredded
    1/2 cup mayonnaise
    2 eggs
    1 sleeve butter crackers, crushed
    3 tbsp butter, melted`, `
    Simmer the squash and onion until tender and drain very well.
    Mix with the cheddar, mayonnaise and eggs and spread in a baking dish.
    Toss the crackers with the melted butter and scatter over the top.
    Bake at 350°F for 30 minutes.`),
  D('Side Dish', 'Daniel Kim', 'Wild Rice Pilaf with Cranberries', `
    1 1/2 cups wild rice blend
    3 cups vegetable broth
    1/2 cup dried cranberries
    1/2 cup pecans, toasted
    1 shallot, minced
    2 tbsp olive oil
    2 tbsp fresh parsley`, `
    Sauté the shallot in the oil, add the rice and toast 2 minutes.
    Add the broth, cover and simmer 45 minutes until tender.
    Fold in the cranberries, pecans and parsley.`),
  D('Side Dish', 'Agnes Novak', 'Parker House Rolls', `
    4 cups all-purpose flour
    1 cup warm milk
    1 packet instant yeast
    1/4 cup sugar
    1 egg
    6 tbsp butter, plus more for brushing
    1 tsp salt
    Flaky sea salt`, `
    Mix the flour, yeast, sugar and salt, then add the milk, egg and softened butter and knead 8 minutes.
    Let rise until doubled, about an hour.
    Roll out, cut rounds, brush with butter and fold each in half.
    Arrange snugly in a pan, rise 30 minutes, and bake at 375°F for 18 minutes.
    Brush with more butter and sprinkle with flaky salt while hot.`),
  D('Side Dish', 'Lula Freeman', 'Buttermilk Biscuits', `
    3 cups all-purpose flour
    1 tbsp baking powder
    1 tsp baking soda
    1 tsp salt
    1 stick cold butter, grated
    1 1/4 cups cold buttermilk`, `
    Heat the oven to 450°F.
    Whisk the dry ingredients and cut in the grated butter.
    Stir in the buttermilk just until the dough comes together.
    Pat out, fold over itself three times, and cut straight down without twisting.
    Bake touching each other on a sheet pan for 14 minutes until tall and golden.`),
  D('Side Dish', 'Kendra Hayes', 'Sweet Potato Rolls', `
    1 cup mashed sweet potato
    3 1/2 cups all-purpose flour
    1/2 cup warm milk
    1 packet instant yeast
    3 tbsp brown sugar
    4 tbsp butter
    1 egg
    1 tsp salt`, `
    Combine everything into a soft dough and knead 6 minutes.
    Let rise until doubled.
    Shape into 16 balls, set in a buttered pan, and rise 40 minutes.
    Bake at 350°F for 22 minutes until deep golden.`),
  D('Side Dish', 'Walter Briggs', 'Turkey Gravy from Drippings', `
    Pan drippings from one roast turkey
    1/4 cup all-purpose flour
    4 cups turkey stock
    1 tbsp butter
    1 sprig fresh thyme
    Salt and pepper`, `
    Pour the drippings into a fat separator. Return 1/4 cup of the fat to the roasting pan.
    Whisk in the flour over medium heat and cook 3 minutes until golden.
    Whisk in the stock and the defatted drippings, scraping up the browned bits.
    Simmer with the thyme until thick, about 10 minutes. Finish with the butter and season.`),
  D('Side Dish', 'Sophie Laurent', 'Roasted Root Vegetables', `
    1 lb parsnips
    1 lb carrots
    1 lb sweet potatoes
    1 red onion
    3 tbsp olive oil
    1 tbsp fresh rosemary
    Salt and pepper`, `
    Heat the oven to 425°F.
    Cut everything into even 1 inch pieces and toss with the oil, rosemary, salt and pepper.
    Roast on two sheet pans for 40 minutes, stirring once, until caramelized.`),
  D('Side Dish', 'Joan Murphy', 'Scalloped Potatoes', `
    3 lb russet potatoes, thinly sliced
    2 cups heavy cream
    1 cup whole milk
    2 cloves garlic
    1 1/2 cups Gruyère, grated
    2 tbsp butter
    1/4 tsp nutmeg`, `
    Heat the cream, milk, garlic and nutmeg until steaming.
    Layer the potatoes in a buttered dish with the cheese, pouring cream over each layer.
    Cover and bake at 350°F for 45 minutes, then uncover and bake 30 more until golden and tender.`),
  D('Side Dish', 'Peggy Sue Harlan', 'Broccoli Rice Casserole', `
    2 cups cooked rice
    1 lb broccoli florets, steamed
    1 can cream of mushroom soup
    1 cup cheddar, shredded
    1/2 cup milk
    1 onion, diced
    2 tbsp butter`, `
    Cook the onion in the butter until soft.
    Stir together everything except half the cheese and spread in a dish.
    Top with the remaining cheese and bake at 350°F for 30 minutes.`),
  D('Side Dish', 'Martha Kincaid', 'Waldorf Salad', `
    4 apples, diced
    2 ribs celery, sliced
    1 cup red grapes, halved
    3/4 cup walnuts, toasted
    1/2 cup mayonnaise
    1/2 cup plain yogurt
    1 lemon, juiced`, `
    Toss the apples with the lemon juice so they do not brown.
    Add the celery, grapes and walnuts.
    Fold in the mayonnaise and yogurt and chill before serving.`),
  D('Side Dish', 'Chloe Bennett', 'Autumn Harvest Salad', `
    8 oz mixed greens
    1 pear, sliced
    1/2 cup dried cranberries
    1/2 cup candied pecans
    4 oz goat cheese
    1/4 cup olive oil
    2 tbsp maple syrup
    2 tbsp apple cider vinegar`, `
    Whisk the oil, maple syrup and vinegar into a dressing.
    Arrange the greens, pear, cranberries and pecans on a platter.
    Crumble the goat cheese over the top and dress just before serving.`),
  D('Side Dish', 'Opal Davenport', 'Ambrosia Salad', `
    1 can mandarin oranges, drained
    1 can pineapple tidbits, drained
    1 cup mini marshmallows
    1 cup shredded coconut
    1 cup sour cream
    1/2 cup maraschino cherries`, `
    Fold the fruit, marshmallows and coconut into the sour cream.
    Chill at least 4 hours so the flavours meld.
    Top with the cherries before serving.`),
  D('Side Dish', 'Ray Gunderson', 'Seven-Layer Salad', `
    1 head iceberg lettuce, chopped
    1 cup frozen peas, thawed
    1 red onion, diced
    6 hard-boiled eggs, sliced
    1 cup mayonnaise
    1 tbsp sugar
    2 cups cheddar, shredded
    8 slices bacon, crumbled`, `
    Layer the lettuce, peas, onion and eggs in a glass bowl.
    Mix the mayonnaise and sugar and spread it over the top to seal.
    Cover with the cheese and bacon and refrigerate overnight.`),

  // ---- Appetizer ------------------------------------------------------------
  D('Appetizer', 'Mildred Fox', 'Classic Deviled Eggs', `
    12 large eggs
    1/2 cup mayonnaise
    1 tbsp yellow mustard
    1 tbsp sweet pickle relish
    Salt and pepper
    Paprika for dusting`, `
    Cover the eggs with cold water, bring to a boil, then cover and let stand 12 minutes.
    Chill in ice water, peel and halve lengthwise.
    Mash the yolks with the mayonnaise, mustard and relish and season.
    Pipe back into the whites and dust with paprika.`),
  D('Appetizer', 'Javier Ortega', 'Bacon-Jalapeño Deviled Eggs', `
    12 large eggs
    1/2 cup mayonnaise
    2 tsp Dijon mustard
    2 jalapeños, minced
    6 slices bacon, crumbled
    1 tsp hot sauce`, `
    Hard-boil, chill and peel the eggs, then halve them.
    Mash the yolks with the mayonnaise, mustard, hot sauce and most of the jalapeño.
    Fill the whites and top with the bacon and remaining jalapeño.`),
  D('Appetizer', 'Heather Collins', 'Spinach Artichoke Dip', `
    10 oz frozen spinach, thawed and squeezed
    1 can artichoke hearts, chopped
    8 oz cream cheese
    1/2 cup sour cream
    1/2 cup mayonnaise
    1 cup parmesan
    1 cup mozzarella
    2 cloves garlic`, `
    Heat the oven to 375°F.
    Beat the cream cheese, sour cream, mayonnaise and garlic until smooth.
    Fold in the spinach, artichokes, parmesan and half the mozzarella.
    Spread in a dish, top with the rest of the mozzarella and bake 25 minutes until bubbling.`),
  D('Appetizer', 'Tyler Mason', 'Buffalo Chicken Dip', `
    3 cups shredded cooked chicken
    8 oz cream cheese
    1/2 cup buffalo hot sauce
    1/2 cup ranch dressing
    1 cup cheddar, shredded
    Celery sticks for serving`, `
    Melt the cream cheese with the hot sauce and ranch.
    Stir in the chicken and half the cheddar and spread in a dish.
    Top with the remaining cheese and bake at 350°F for 20 minutes. Serve with celery.`),
  D('Appetizer', 'Bonnie Whitaker', 'Hot Crab Dip', `
    1 lb lump crabmeat
    8 oz cream cheese
    1/2 cup mayonnaise
    1 tbsp Old Bay seasoning
    1 tsp Worcestershire sauce
    1 lemon, juiced
    1 cup cheddar
    1 baguette, sliced and toasted`, `
    Beat the cream cheese, mayonnaise, Old Bay, Worcestershire and lemon juice.
    Gently fold in the crab and half the cheddar.
    Top with the remaining cheese and bake at 375°F for 25 minutes. Serve with the toasted baguette.`),
  D('Appetizer', 'Vince Romano', 'Shrimp Cocktail', `
    2 lb jumbo shrimp, peeled with tails on
    1 lemon, halved
    2 bay leaves
    1 cup ketchup
    2 tbsp prepared horseradish
    1 tsp hot sauce`, `
    Bring a pot of salted water to a boil with the lemon halves and bay leaves.
    Add the shrimp and cook 2 to 3 minutes until pink, then plunge into ice water.
    Stir the ketchup, horseradish and hot sauce into a cocktail sauce.
    Serve the shrimp chilled around a bowl of the sauce.`),
  D('Appetizer', 'Lauren Michaels', 'Cranberry Brie Bites', `
    1 sheet puff pastry, thawed
    8 oz Brie, cubed
    1/2 cup cranberry sauce
    2 tbsp fresh rosemary
    1/4 cup pecans, chopped`, `
    Heat the oven to 375°F. Cut the pastry into 24 squares and press into a mini muffin pan.
    Fill each with a cube of Brie and a spoonful of cranberry sauce.
    Bake 15 minutes until puffed. Top with the pecans and rosemary.`),
  D('Appetizer', 'Earlene Pickett', 'Sausage Balls', `
    1 lb hot breakfast sausage
    2 cups biscuit baking mix
    2 cups sharp cheddar, shredded
    1/4 cup milk`, `
    Heat the oven to 375°F.
    Mix everything with your hands until evenly combined.
    Roll into 1 inch balls and bake on a lined sheet 20 minutes until browned.`),
  D('Appetizer', 'Virginia Dupree', 'Pimento Cheese Spread', `
    3 cups sharp cheddar, freshly grated
    1 jar diced pimentos, drained
    1/2 cup mayonnaise
    2 oz cream cheese
    1/4 tsp cayenne
    Celery and crackers for serving`, `
    Beat the cream cheese and mayonnaise until smooth.
    Fold in the cheddar, pimentos and cayenne.
    Chill one hour and serve with celery and crackers.`),
  D('Appetizer', 'Nadia Petrova', 'Harvest Charcuterie Board', `
    6 oz salami, sliced
    6 oz prosciutto
    8 oz aged cheddar
    6 oz Brie
    1 cup almonds
    1 cup red grapes
    1/2 cup fig jam
    1 box water crackers
    1 cup cornichons
    2 pears, sliced`, `
    Set the cheeses on the board first, spaced apart.
    Fold the meats into loose ribbons and tuck them around the cheese.
    Fill the gaps with the grapes, pears, almonds, cornichons and a bowl of fig jam.
    Fan the crackers along one edge just before serving.`),
  D('Appetizer', 'Anthony Russo', 'Sausage-Stuffed Mushrooms', `
    24 large cremini mushrooms
    1/2 lb Italian sausage
    4 oz cream cheese
    1/4 cup parmesan
    1/4 cup Italian breadcrumbs
    2 cloves garlic
    2 tbsp fresh parsley`, `
    Heat the oven to 375°F. Remove and chop the mushroom stems.
    Brown the sausage with the stems and garlic, then stir in the cream cheese, parmesan and parsley.
    Fill the caps, sprinkle with breadcrumbs and bake 20 minutes.`),
  D('Appetizer', 'Cody Hargrove', 'Pigs in a Blanket', `
    2 cans crescent roll dough
    48 cocktail sausages
    1 egg, beaten
    1 tbsp everything bagel seasoning
    1/2 cup honey mustard`, `
    Heat the oven to 375°F.
    Cut each crescent triangle into three strips and roll each sausage in one.
    Brush with egg, sprinkle with seasoning and bake 13 minutes. Serve with honey mustard.`),
  D('Appetizer', 'María Esperanza Ruiz', 'Seven-Layer Bean Dip', `
    1 can refried beans
    1 packet taco seasoning
    1 cup sour cream
    1 cup guacamole
    1 cup salsa
    1 cup Mexican-blend cheese
    1/2 cup black olives, sliced
    3 green onions, sliced
    Tortilla chips`, `
    Stir the taco seasoning into the beans and spread in a glass dish.
    Layer the sour cream, guacamole, salsa and cheese.
    Finish with the olives and green onions. Serve with chips. ¡Buen provecho!`),
  D('Appetizer', 'Patsy Calhoun', 'Cheese Ball with Pecans', `
    16 oz cream cheese, softened
    2 cups sharp cheddar
    1 tbsp Worcestershire sauce
    1 tsp garlic powder
    2 green onions, minced
    1 cup pecans, finely chopped
    Butter crackers for serving`, `
    Beat the cream cheese, cheddar, Worcestershire, garlic powder and green onions.
    Shape into a ball, wrap in plastic and chill 2 hours.
    Roll in the pecans and serve with crackers.`),
  D('Appetizer', 'Leila Haddad', 'Hummus with Roasted Red Peppers', `
    2 cans chickpeas, drained
    1/2 cup tahini
    2 lemons, juiced
    2 cloves garlic
    1/3 cup olive oil
    1 roasted red pepper
    1 tsp cumin
    Pita chips for serving`, `
    Blend the chickpeas, tahini, lemon juice, garlic and cumin until smooth, streaming in ice water to loosen.
    Add the roasted pepper and blend again.
    Spread in a bowl, drizzle with the olive oil and serve with pita chips.`),
  D('Appetizer', 'Henry Zhao', 'Pan-Fried Pork Dumplings', `
    1 lb ground pork
    40 dumpling wrappers
    2 cups napa cabbage, finely chopped
    3 green onions
    1 tbsp fresh ginger
    2 tbsp soy sauce
    1 tbsp toasted sesame oil
    2 tbsp rice vinegar`, `
    Salt the cabbage for 10 minutes and squeeze dry.
    Mix with the pork, green onions, ginger, half the soy sauce and the sesame oil.
    Fill and pleat the wrappers.
    Pan-fry until the bottoms are golden, add a splash of water, cover and steam 6 minutes.
    Serve with the rest of the soy sauce mixed with the vinegar.`),

  // ---- Dessert --------------------------------------------------------------
  D('Dessert', 'Evelyn Marsh', 'Classic Pumpkin Pie', `
    1 unbaked pie crust
    1 can pumpkin puree, 15 oz
    3/4 cup sugar
    2 eggs
    1 can evaporated milk
    1 tsp cinnamon
    1/2 tsp ground ginger
    1/4 tsp ground cloves
    1/2 tsp salt`, `
    Heat the oven to 425°F.
    Whisk the pumpkin, sugar, eggs, spices and salt, then whisk in the evaporated milk.
    Pour into the crust and bake 15 minutes.
    Lower to 350°F and bake 40 to 50 minutes until the center barely jiggles.
    Cool completely before slicing.`),
  D('Dessert', 'Amélie Dubois', 'Crème Brûlée Pumpkin Pie 🥧', `
    1 all-butter pie crust, blind-baked
    1 can pumpkin purée, 15 oz
    1 cup heavy cream
    3 egg yolks
    1 whole egg
    2/3 cup brown sugar
    1 tsp vanilla bean paste
    1 1/2 tsp cinnamon
    1/2 tsp ginger
    1/4 tsp nutmeg
    1/4 cup superfine sugar for the brûlée`, `
    Blind-bake the crust: line the chilled pie shell with parchment and fill it to the brim with pie weights or dried beans, then bake at 400°F for 20 minutes. Lift out the weights, prick the base with a fork and bake 8 to 10 minutes more until the bottom looks dry and lightly golden. A properly blind-baked shell is what keeps the custard from soaking through and turning the crust gummy.
    Lower the oven to 325°F. Warm the cream in a small saucepan until it just steams around the edges, with the vanilla bean paste stirred in; do not let it boil, or the custard can take on a cooked, eggy flavour.
    In a large bowl, whisk the pumpkin purée with the brown sugar, cinnamon, ginger, nutmeg and a pinch of salt until completely smooth. Whisk in the egg yolks and the whole egg one at a time, then pour the warm cream in slowly while whisking so the eggs never scramble.
    Strain the custard through a fine sieve into a jug, pressing it through with a spatula. This removes the stringy bits of pumpkin and any cooked egg and gives the silky texture that makes this pie taste like a crème brûlée rather than an ordinary pumpkin pie.
    Set the pie shell on a sheet pan, pull the oven rack halfway out and pour the custard in there, so you do not slosh it across the kitchen. Bake 45 to 55 minutes, until the edges are set and the center still wobbles like gelatin when you nudge the pan.
    Cool the pie on a rack for one hour, then refrigerate it, uncovered, for at least four hours or overnight. The custard must be fully cold and set before the brûlée, or the heat of the torch will melt it underneath the sugar.
    Just before serving, blot any condensation from the surface with a paper towel. Sprinkle the superfine sugar evenly over the top in a thin layer, tilting the pie so it covers edge to edge without piling up in the middle.
    Caramelize the sugar with a kitchen torch held a few inches away, moving it in small circles until the sugar melts, bubbles and turns a deep amber. Let it harden for two minutes, then slice with a hot knife wiped clean between cuts. C'est délicieux. 🎃`, 9),
  D('Dessert', 'Mamie Sutton', 'Southern Pecan Pie', `
    1 unbaked pie crust
    1 cup light corn syrup
    1 cup dark brown sugar
    3 eggs
    1/3 cup butter, melted
    1 tsp vanilla
    1 1/2 cups pecan halves`, `
    Heat the oven to 350°F.
    Whisk the corn syrup, brown sugar, eggs, butter and vanilla.
    Arrange the pecans in the crust and pour the filling over.
    Bake 55 to 60 minutes until set, covering the edges if they brown too fast.`),
  D('Dessert', 'Cora Lee Jackson', 'Sweet Potato Pie', `
    1 unbaked pie crust
    2 cups mashed sweet potatoes
    1/2 cup butter, softened
    1 cup sugar
    1/2 cup evaporated milk
    2 eggs
    1 tsp vanilla
    1/2 tsp nutmeg
    1/2 tsp cinnamon`, `
    Heat the oven to 350°F.
    Beat the sweet potatoes with the butter until smooth, then beat in the sugar, milk, eggs, vanilla and spices.
    Pour into the crust and bake 55 to 60 minutes until a knife comes out clean.`),
  D('Dessert', 'Gerrit Vandenberg', 'Dutch Apple Pie', `
    1 unbaked pie crust
    6 Granny Smith apples, sliced
    1/2 cup sugar
    2 tbsp all-purpose flour
    1 tsp cinnamon
    1 lemon, juiced
    3/4 cup brown sugar
    3/4 cup all-purpose flour for topping
    1/2 cup cold butter
    1/2 cup rolled oats`, `
    Heat the oven to 375°F.
    Toss the apples with the sugar, two tablespoons flour, cinnamon and lemon juice and pile into the crust.
    Rub the brown sugar, flour, butter and oats into a crumble and pack it over the apples.
    Bake 55 minutes until the juices bubble through the topping.`),
  D('Dessert', 'Ernestine Booker', 'Peach Cobbler', `
    8 cups sliced peaches
    1 cup sugar
    1 tsp cinnamon
    1/2 tsp nutmeg
    1 stick butter
    1 cup all-purpose flour
    1 cup milk
    2 tsp baking powder`, `
    Heat the oven to 350°F and melt the butter in a 9 by 13 dish in the oven.
    Simmer the peaches with half the sugar and the spices for 10 minutes.
    Whisk the flour, remaining sugar, baking powder and milk and pour over the melted butter without stirring.
    Spoon the peaches over the batter and bake 45 minutes until golden.`),
  D('Dessert', 'Junie Pruett', 'Blackberry Cobbler', `
    6 cups blackberries
    1 cup sugar
    2 tbsp cornstarch
    1 lemon, zested
    2 cups all-purpose flour
    1/2 cup cold butter
    3/4 cup buttermilk`, `
    Toss the berries with half the sugar, the cornstarch and the zest and spread in a dish.
    Cut the butter into the flour and remaining sugar, then stir in the buttermilk.
    Drop spoonfuls of the dough over the fruit.
    Bake at 375°F for 40 minutes until bubbling.`),
  D('Dessert', 'Odessa Grant', 'Banana Pudding', `
    1 box vanilla wafers
    5 ripe bananas, sliced
    3/4 cup sugar
    1/3 cup all-purpose flour
    3 cups whole milk
    4 egg yolks
    1 tsp vanilla
    2 cups whipped cream`, `
    Whisk the sugar, flour, milk and yolks in a saucepan and cook, stirring, until thick.
    Stir in the vanilla and cool.
    Layer the wafers, bananas and pudding in a trifle dish.
    Top with whipped cream and chill at least 4 hours.`),
  D('Dessert', 'Rachel Goldberg', 'Pumpkin Cheesecake', `
    2 cups graham cracker crumbs
    1/2 cup butter, melted
    24 oz cream cheese
    1 cup sugar
    1 can pumpkin puree
    3 eggs
    1 tsp pumpkin pie spice
    1 tsp vanilla`, `
    Press the crumbs and butter into a springform pan and bake at 350°F for 10 minutes.
    Beat the cream cheese and sugar, then the pumpkin, spice and vanilla, then the eggs one at a time.
    Pour over the crust and bake in a water bath at 325°F for 70 minutes.
    Cool in the oven with the door ajar, then chill overnight.`),
  D('Dessert', 'Velma Harper', 'Chess Pie', `
    1 unbaked pie crust
    1 1/2 cups sugar
    1/2 cup butter, melted
    4 eggs
    1 tbsp cornmeal
    1 tbsp white vinegar
    1/4 cup milk
    1 tsp vanilla`, `
    Heat the oven to 350°F.
    Whisk all the filling ingredients until smooth.
    Pour into the crust and bake 45 minutes until golden and just set.`),
  D('Dessert', 'Lucien Boudreaux', 'Bourbon Bread Pudding', `
    1 loaf day-old French bread, cubed
    4 cups whole milk
    4 eggs
    1 1/2 cups sugar
    1/2 cup raisins
    1 tbsp vanilla
    1 stick butter
    1/4 cup bourbon
    1 cup powdered sugar`, `
    Soak the bread in the milk, eggs, sugar and vanilla for 30 minutes. Fold in the raisins.
    Bake in a buttered dish at 350°F for 50 minutes.
    Melt the butter with the powdered sugar and stir in the bourbon for the sauce.
    Pour the warm sauce over each serving.`),
  D('Dessert', 'Kathy Swenson', 'Apple Crisp', `
    6 apples, sliced
    1 tbsp lemon juice
    1 cup rolled oats
    3/4 cup brown sugar
    1/2 cup all-purpose flour
    1/2 cup butter
    1 tsp cinnamon`, `
    Toss the apples with the lemon juice and spread in a dish.
    Rub together the oats, sugar, flour, butter and cinnamon and scatter over.
    Bake at 350°F for 45 minutes until crisp and bubbling.`),
  D('Dessert', 'Debbie Kline', 'Pumpkin Roll', `
    3 eggs
    1 cup sugar
    2/3 cup pumpkin puree
    3/4 cup all-purpose flour
    1 tsp baking soda
    2 tsp cinnamon
    8 oz cream cheese
    1 cup powdered sugar
    6 tbsp butter
    1 tsp vanilla`, `
    Beat the eggs and sugar, add the pumpkin, then fold in the flour, soda and cinnamon.
    Spread in a lined jelly roll pan and bake at 375°F for 13 minutes.
    Roll the warm cake up in a towel dusted with powdered sugar and cool.
    Beat the cream cheese, butter, powdered sugar and vanilla, unroll, spread and roll again. Chill before slicing.`),
  D('Dessert', 'Loretta Simms', 'Red Velvet Cake', `
    2 1/2 cups all-purpose flour
    1 1/2 cups sugar
    1 tsp baking soda
    1 tbsp cocoa powder
    1 1/2 cups vegetable oil
    1 cup buttermilk
    2 eggs
    2 tbsp red food coloring
    16 oz cream cheese
    1 cup butter
    4 cups powdered sugar`, `
    Heat the oven to 350°F and grease two 9 inch pans.
    Whisk the dry ingredients, then mix in the oil, buttermilk, eggs and coloring.
    Bake 30 minutes and cool completely.
    Beat the cream cheese, butter and powdered sugar and frost between the layers and over the cake.`),
  D('Dessert', 'Sandra Whitley', 'Caramel Apple Cake', `
    3 cups all-purpose flour
    2 cups sugar
    1 1/4 cups vegetable oil
    3 eggs
    3 cups apples, diced
    1 tsp cinnamon
    1 tsp baking soda
    1 cup caramel sauce`, `
    Heat the oven to 350°F and grease a tube pan.
    Mix the oil, sugar and eggs, then the dry ingredients, then fold in the apples.
    Bake 70 minutes, cool 15, and turn out.
    Drizzle the caramel over the warm cake.`),
  D('Dessert', 'Helen Fairchild', 'Cranberry Orange Bundt Cake', `
    3 cups all-purpose flour
    2 cups sugar
    1 cup butter, softened
    4 eggs
    1 cup sour cream
    2 oranges, zested and juiced
    2 cups fresh cranberries
    1 cup powdered sugar`, `
    Cream the butter and sugar, beat in the eggs, then the sour cream and zest.
    Fold in the flour and the cranberries.
    Bake in a greased Bundt pan at 350°F for 60 minutes.
    Whisk the powdered sugar with orange juice into a glaze and pour over the cooled cake.`),
  D('Dessert', 'Jimmy Ray Tucker', 'Peanut Butter Pie', `
    1 chocolate cookie crust
    8 oz cream cheese
    1 cup creamy peanut butter
    1 cup powdered sugar
    8 oz whipped topping
    1/4 cup chopped peanuts
    2 tbsp chocolate syrup`, `
    Beat the cream cheese, peanut butter and powdered sugar until fluffy.
    Fold in the whipped topping and spread in the crust.
    Top with the peanuts and chocolate syrup and chill 4 hours.`),
  D('Dessert', 'Beatrice Owens', 'Coconut Cream Pie', `
    1 baked pie crust
    3 cups whole milk
    3/4 cup sugar
    1/4 cup cornstarch
    4 egg yolks
    1 1/2 cups sweetened coconut
    2 tbsp butter
    2 cups whipped cream`, `
    Whisk the milk, sugar, cornstarch and yolks and cook until thick.
    Stir in the butter and one cup of coconut and pour into the crust.
    Chill until set, top with whipped cream and the remaining coconut, toasted.`),
  D('Dessert', 'Antoinette Leblanc', 'Pecan Pralines', `
    1 1/2 cups sugar
    3/4 cup light brown sugar
    1/2 cup whole milk
    6 tbsp butter
    2 cups pecan halves
    1 tsp vanilla`, `
    Bring the sugars, milk and butter to a boil and cook to 238°F, stirring.
    Remove from the heat, stir in the pecans and vanilla, and beat until it thickens and turns cloudy.
    Drop by spoonfuls onto parchment and let set.`),
  D('Dessert', 'Lupe Fernández', 'Tres Leches Pumpkin Cake 🎃', `
    1 box yellow cake mix
    1 cup pumpkin purée
    3 eggs
    1/3 cup vegetable oil
    1 can sweetened condensed milk
    1 can evaporated milk
    1 cup heavy cream
    1 tsp cinnamon
    2 cups whipped cream`, `
    Bake the cake mix with the pumpkin, eggs, oil and cinnamon in a 9 by 13 pan at 350°F for 30 minutes.
    Poke holes all over the warm cake with a fork.
    Whisk the three milks and pour slowly over the cake.
    Chill overnight, then spread with whipped cream. ¡Qué rico!`),
];

/** Fail fast if the hand-written data would break a rule the contest enforces. */
function checkDishData() {
  const problems = [];
  const names = new Set();
  for (const d of DISHES) {
    if (!CATEGORY_NAMES.includes(d.category)) problems.push(`${d.name}: unknown category`);
    if (names.has(d.name)) problems.push(`${d.name}: duplicate`);
    names.add(d.name);
    if (d.ingredientCount < 4 || d.ingredientCount > 14) problems.push(`${d.name}: ${d.ingredientCount} ingredients`);
    if (d.stepCount < 3 || d.stepCount > 10) problems.push(`${d.name}: ${d.stepCount} steps`);
    if (d.recipe.length > 8000) problems.push(`${d.name}: recipe ${d.recipe.length} chars`);
    if (d.ingredients.length > 2000) problems.push(`${d.name}: ingredients ${d.ingredients.length} chars`);
    if (d.name.length > 80 || d.cook.length > 80) problems.push(`${d.name}: name/cook too long`);
  }
  if (DISHES.length < 80) problems.push(`only ${DISHES.length} dishes`);
  if (DISHES.filter((d) => d.recipe.length > 7500).length < 3) problems.push('fewer than 3 long recipes');
  if (!DISHES.some((d) => d.recipe.replace(/\n/g, '\r\n').length > 8000)) problems.push('no recipe exceeds the cap when CRLF-encoded');
  if (problems.length) throw new Error(`dish data: ${problems.join('; ')}`);
}

/**
 * The first `n` of the seeded shuffle, except that the near-cap and non-ASCII dishes always
 * lead the list (so even --dishes 30 exercises the 8,000-char cap and multi-byte text through
 * the public submit path) and one near-cap dish goes last (so the admin walk-in path gets one too).
 */
function selectDishes(n) {
  const shuffled = shuffle(DISHES, mulberry32(SEED + 1));
  const special = (d) => d.recipe.length > 7500 || /[^\x00-\x7F]/.test(d.name + d.cook + d.recipe.replace(/°/g, ''));
  const lead = shuffled.filter(special);
  const tail = lead.find((d) => d.recipe.length > 7500);
  const rest = shuffled.filter((d) => !special(d));
  return [...lead.filter((d) => d !== tail), ...rest.slice(0, n - lead.length), tail];
}

// ---- photos -----------------------------------------------------------------

async function makePhotos(sharp) {
  const variants = [];
  const W = 3000; const H = 2250;
  const raw = Buffer.alloc(W * H * 3);
  const fill = (seed, amp, hue) => {
    const r = mulberry32(seed);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        const n = (r() - 0.5) * 2 * amp;
        raw[i] = Math.max(0, Math.min(255, hue[0] + 60 * Math.sin(x / 300) + n));
        raw[i + 1] = Math.max(0, Math.min(255, hue[1] + 40 * Math.cos(y / 200) + n));
        raw[i + 2] = Math.max(0, Math.min(255, hue[2] + 30 * Math.sin((x + y) / 400) + n));
      }
    }
  };
  const hues = [[150, 90, 50], [170, 120, 60], [120, 70, 40], [190, 140, 80]];
  for (let k = 0; k < 4; k++) {
    fill(SEED + k, 14 + k * 5, hues[k]);
    const buf = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
    variants.push({ kind: 'jpeg', buf, type: 'image/jpeg', filename: `IMG_${4100 + k}.JPG`, portrait: false });
  }
  for (let k = 0; k < 2; k++) {
    fill(SEED + 10 + k, 18, hues[k + 1]);
    // Landscape pixels, EXIF orientation 6: a phone held upright. Served correctly it is portrait.
    const buf = await sharp(raw, { raw: { width: W, height: H, channels: 3 } })
      .jpeg({ quality: 88 }).withMetadata({ orientation: 6 }).toBuffer();
    variants.push({ kind: 'jpeg-exif-portrait', buf, type: 'image/jpeg', filename: `IMG_${4200 + k}.JPG`, portrait: true });
  }
  fill(SEED + 20, 10, hues[3]);
  const png = await sharp(raw, { raw: { width: W, height: H, channels: 3 } })
    .resize({ width: 1600 }).png({ compressionLevel: 6 }).toBuffer();
  variants.push({ kind: 'png', buf: png, type: 'image/png', filename: 'Screenshot 2026-11-20.png', portrait: false });
  return variants;
}

// ---- harness (child process) ------------------------------------------------

async function runHarness(dir, port) {
  // The route module builds a default instance at import (mkdir <ROOT>/data/.uploads-tmp and a
  // lazy store on <ROOT>/data/contest). Point ROOT into the temp dir before importing it.
  process.env.SEO_CLAUDE_ROOT = join(dir, 'sandbox-root');
  fs.mkdirSync(process.env.SEO_CLAUDE_ROOT, { recursive: true });
  const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);
  const [{ default: multer }, { createContestStore }, routesMod, { dispatch }] = await Promise.all([
    import('multer'), imp('lib/contest-store.js'), imp('agents/dashboard/routes/contest.js'), imp('agents/dashboard/lib/router.js'),
  ]);

  const RESOLUTION_MS = 10;
  const loop = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  loop.enable();
  let peakRss = 0; let peakHeap = 0;
  const sample = () => {
    const m = process.memoryUsage();
    peakRss = Math.max(peakRss, m.rss);
    peakHeap = Math.max(peakHeap, m.heapUsed);
  };
  sample();
  setInterval(sample, 200).unref();

  const routes = routesMod.createContestRoutes({
    store: createContestStore({ dir }),
    publicBase: `http://127.0.0.1:${port}`,
    upload: multer({ dest: join(dir, 'uploads-tmp'), limits: routesMod.UPLOAD_LIMITS }),
    publicDir: PUBLIC_DIR,
  });

  // The histogram includes the sampling interval itself; report only the delay beyond it.
  const ms = (ns) => Number(Math.max(0, ns / 1e6 - RESOLUTION_MS).toFixed(2));
  const server = http.createServer((req, res) => {
    const p = String(req.url).split('?')[0];
    if (p === '/__stress/metrics' && req.method === 'GET') {
      sample();
      const m = process.memoryUsage();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        rss: m.rss, heapUsed: m.heapUsed, peakRss, peakHeap,
        eventLoopDelay: { p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max: ms(loop.max) },
      }));
      return;
    }
    if (p === '/__stress/metrics/reset' && req.method === 'POST') {
      loop.reset();
      const m = process.memoryUsage();
      peakRss = m.rss; peakHeap = m.heapUsed;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (!dispatch(routes, req, res, {})) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });
  server.listen(port, '127.0.0.1', () => process.send?.({ ready: true, pid: process.pid }));
  process.on('disconnect', () => process.exit(0));
}

// ---- parent: options --------------------------------------------------------

function parseArgs(argv) {
  const o = { dishes: 45, voters: 100, minutes: 4, port: 4250, report: null, keep: false };
  const num = (a, v) => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n)) die(`${a} needs a number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dishes') o.dishes = num(a, argv[++i]);
    else if (a === '--voters') o.voters = num(a, argv[++i]);
    else if (a === '--minutes') o.minutes = num(a, argv[++i]);
    else if (a === '--port') o.port = num(a, argv[++i]);
    else if (a === '--report') { o.report = argv[++i]; if (!o.report) die('--report needs a path'); }
    else if (a === '--keep') o.keep = true;
    else die(`Unknown argument: ${a}`);
  }
  if (!Number.isInteger(o.dishes) || o.dishes < 30 || o.dishes > 80) die('--dishes must be a whole number from 30 to 80');
  if (!Number.isInteger(o.voters) || o.voters < 1 || o.voters > 1000) die('--voters must be a whole number from 1 to 1000');
  if (o.minutes < 1 || o.minutes > 60) die('--minutes must be between 1 and 60');
  if (!Number.isInteger(o.port) || o.port < 1024 || o.port > 65535) die('--port must be a whole number from 1024 to 65535');
  if (o.port === DASHBOARD_PORT) die(`--port ${DASHBOARD_PORT} is the live dashboard; refusing`);
  return o;
}

function die(msg) {
  console.error(`contest-stress: ${msg}`);
  process.exit(2);
}

// ---- parent: HTTP client with per-endpoint stats ----------------------------

const stats = new Map();
const counters = { networkErrors: 0, retries: 0, unrecovered: 0, status429: 0, status5xx: 0 };

function endpointKey(method, path) {
  let p = path.split('?')[0];
  if (/^\/contest\/photos\//.test(p)) p = '/contest/photos/:id-:v.webp';
  return `${method} ${p}`;
}

function record(key, status, ms) {
  let s = stats.get(key);
  if (!s) { s = { count: 0, statuses: {}, lat: [] }; stats.set(key, s); }
  s.count += 1;
  s.statuses[status] = (s.statuses[status] || 0) + 1;
  s.lat.push(ms);
  if (status === 429) counters.status429 += 1;
  if (typeof status === 'number' && status >= 500) counters.status5xx += 1;
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

let BASE = '';

async function call(method, path, { ip, json, form, keepBody = false, retry = true, timeoutMs = 60_000 } = {}) {
  const key = endpointKey(method, path);
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = {};
    if (ip) headers['X-Real-IP'] = ip;
    let body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form();
    const t0 = performance.now();
    try {
      const res = await fetch(BASE + path, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      const buf = Buffer.from(await res.arrayBuffer());
      record(key, res.status, performance.now() - t0);
      const ct = res.headers.get('content-type') || '';
      let parsed = null;
      if (ct.includes('application/json')) { try { parsed = JSON.parse(buf.toString('utf8')); } catch { parsed = null; } }
      return { status: res.status, ct, size: buf.length, json: parsed, buf: keepBody ? buf : null };
    } catch (err) {
      record(key, 'ERR', performance.now() - t0);
      counters.networkErrors += 1;
      if (attempt === 0 && retry) { counters.retries += 1; continue; }
      counters.unrecovered += 1;
      return { status: 0, error: err.cause?.code || err.message, json: null, size: 0 };
    }
  }
  throw new Error('unreachable');
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

// ---- parent: checks, phases, harness control --------------------------------

const checks = [];
const phases = [];
let currentPhase = '';

function check(name, pass, detail = '') {
  checks.push({ phase: currentPhase, name, pass: Boolean(pass), detail: String(detail) });
  return Boolean(pass);
}

let child = null;
let childStderr = [];
let routerErrors = 0;
let tmpDir = null;
let keepDir = false;

function startHarness(dir, port) {
  return new Promise((resolve, reject) => {
    const c = fork(SCRIPT, ['--harness', dir, String(port)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child = c;
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('harness did not start within 30 s')); } }, 30_000);
    c.stdout.on('data', () => {});
    c.stderr.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        if (!line.trim()) continue;
        if (line.includes('[router] unhandled error')) routerErrors += 1;
        childStderr.push(line);
        if (childStderr.length > 200) childStderr.shift();
      }
    });
    c.on('message', (m) => {
      if (m && m.ready && !settled) { settled = true; clearTimeout(timer); resolve(c); }
    });
    c.on('exit', (code, sig) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`harness exited early (${code ?? sig}): ${childStderr.slice(-5).join(' | ')}`)); }
    });
  });
}

function killHarness() {
  return new Promise((resolve) => {
    const c = child;
    if (!c || c.exitCode !== null || c.signalCode !== null) { resolve(); return; }
    c.once('exit', () => resolve());
    c.kill('SIGKILL');
  });
}

function cleanupSync() {
  try { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* gone */ }
  if (tmpDir && !keepDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    tmpDir = null;
  }
}

async function metrics() {
  const r = await call('GET', '/__stress/metrics');
  return r.json;
}
async function resetMetrics() {
  await call('POST', '/__stress/metrics/reset');
}

async function admin(action, body = {}) {
  const r = await call('POST', `/api/contest/admin/${action}`, { json: body });
  if (r.status !== 200) throw new Error(`admin/${action} returned ${r.status}: ${JSON.stringify(r.json)}`);
  return r.json.state;
}
async function adminState() {
  const r = await call('GET', '/api/contest/admin/state');
  if (r.status !== 200) throw new Error(`admin/state returned ${r.status}`);
  return r.json.state;
}
async function publicState() {
  const r = await call('GET', '/api/contest/public');
  if (r.status !== 200) throw new Error(`public returned ${r.status}`);
  return r.json;
}

/** Every [path, key] pair in an object tree. */
function walkKeys(obj, path = '', out = []) {
  if (Array.isArray(obj)) obj.forEach((v, i) => walkKeys(v, `${path}[${i}]`, out));
  else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      out.push([path, k]);
      walkKeys(v, path ? `${path}.${k}` : k, out);
    }
  }
  return out;
}

function listFiles(d) {
  const out = [];
  if (!fs.existsSync(d)) return out;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

// ---- main ---------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  checkDishData();
  const startedAll = Date.now();
  const rnd = mulberry32(SEED);
  BASE = `http://127.0.0.1:${opts.port}`;

  // Refuse a port that is already taken rather than talking to whatever owns it.
  await new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => die(`port ${opts.port} is already in use`));
    probe.listen(opts.port, '127.0.0.1', () => probe.close(resolve));
  });

  tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'contest-stress-'));
  keepDir = opts.keep;
  const dir = tmpDir;
  process.on('exit', cleanupSync);
  process.on('SIGINT', () => { cleanupSync(); process.exit(130); });
  process.on('SIGTERM', () => { cleanupSync(); process.exit(143); });
  process.on('uncaughtException', (err) => { console.error(err); cleanupSync(); process.exit(1); });

  let parentPeakRss = 0;
  const parentSampler = setInterval(() => { parentPeakRss = Math.max(parentPeakRss, process.memoryUsage().rss); }, 500);
  parentSampler.unref();

  const { default: sharp } = await import('sharp');
  console.log(`contest-stress: temp dir ${dir}, harness port ${opts.port}`);
  console.log(`  ${opts.dishes} dishes, ${opts.voters} voters, ${opts.minutes} min voting window`);
  console.log('  generating photos...');
  const photos = await makePhotos(sharp);
  const photoSizes = photos.map((p) => `${p.kind} ${(p.buf.length / 1e6).toFixed(2)} MB`);
  console.log(`  photos: ${photoSizes.join(', ')}`);

  await startHarness(dir, opts.port);

  const ctx = {
    rnd, opts, dir, photos, sharp,
    dishes: selectDishes(opts.dishes),
    catByName: {}, catIds: [],
    entries: [], // { spec, dishId, token, photo, source, sent }
    voters: [],
    expected: new Map(),
    expectedEvents: 0,
    metrics: {},
  };

  const PHASES = [
    ['A. Setup + submissions', phaseA],
    ['B. Browse before voting', phaseB],
    ['C. Voting', phaseC],
    ['D. Deadline', phaseD],
    ['E. Tally verification', phaseE],
    ['F. Reveal', phaseF],
    ['G. Restart persistence', phaseG],
  ];
  let aborted = null;
  for (const [name, fn] of PHASES) {
    currentPhase = name;
    if (aborted) { phases.push({ name, ms: 0, skipped: true }); continue; }
    console.log(`\n${name}`);
    const t0 = Date.now();
    try {
      await fn(ctx);
    } catch (err) {
      check('phase completed without crashing', false, err.stack?.split('\n').slice(0, 2).join(' ') || err.message);
      aborted = name;
    }
    phases.push({ name, ms: Date.now() - t0 });
    const failed = checks.filter((c) => c.phase === name && !c.pass).length;
    console.log(`  ${checks.filter((c) => c.phase === name).length} checks, ${failed} failed, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }

  currentPhase = 'H. Report';
  check('no 5xx responses', counters.status5xx === 0, `${counters.status5xx} 5xx`);
  check('harness logged no unhandled route errors', routerErrors === 0, routerErrors ? childStderr.filter((l) => l.includes('[router]')).slice(0, 2).join(' | ') : 'none');
  check('no request was rate-limited (429)', counters.status429 === 0, `${counters.status429} x 429`);
  check('no network error left unrecovered after one retry', counters.unrecovered === 0, `${counters.networkErrors} errors, ${counters.retries} retried, ${counters.unrecovered} unrecovered`);

  await killHarness();
  clearInterval(parentSampler);
  const wallMs = Date.now() - startedAll;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = opts.report || join(os.tmpdir(), `contest-stress-report-${stamp}.md`);
  const md = renderReport({ opts, ctx, wallMs, parentPeakRss, photoSizes, aborted });
  fs.writeFileSync(reportPath, md);
  const summary = renderSummary({ wallMs, ctx, reportPath, parentPeakRss });
  console.log(`\n${summary}`);
  if (opts.keep) console.log(`  --keep: data left in ${dir}`);
  const failed = checks.filter((c) => !c.pass).length;
  process.exitCode = failed ? 1 : 0;
}

// ---- phase A ------------------------------------------------------------------

function dishForm(spec, categoryId, photo, extra = {}) {
  return () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    fd.set('categoryId', categoryId);
    fd.set('name', spec.name);
    fd.set('cook', spec.cook);
    fd.set('ingredients', spec.ingredients);
    fd.set('recipe', spec.recipe);
    for (const a of spec.allergens) fd.append('allergens', a);
    if (photo) fd.set('photo', new Blob([photo.buf], { type: photo.type }), photo.filename);
    return fd;
  };
}

const FORBIDDEN_PUBLIC = new Set(['editToken', 'editTokenHash', 'votes', 'ballots']);
const DISH_PUBLIC_KEYS = ['allergens', 'categoryId', 'cook', 'id', 'ingredients', 'name', 'photoUrl', 'recipe'];

async function phaseA(ctx) {
  const { dishes, photos } = ctx;
  await resetMetrics();
  await admin('title', { title: 'Stress Test Turkey Slam' });
  let state;
  for (const name of CATEGORY_NAMES) state = await admin('category-add', { name });
  for (const c of state.categories) ctx.catByName[c.name] = c.id;
  ctx.catIds = state.categories.map((c) => c.id);
  state = await admin('submissions', { open: true });
  check('contest set up', state.title === 'Stress Test Turkey Slam' && state.categories.length === 4 && state.submissionsOpen === true,
    `title "${state.title}", ${state.categories.length} categories, submissionsOpen ${state.submissionsOpen}`);

  const nPublic = Math.round(dishes.length * 0.75);
  const publicSpecs = dishes.slice(0, nPublic);
  const walkins = dishes.slice(nPublic);

  // Public multipart submissions, concurrency 4, from 6 cook IPs.
  const sub = await pool(publicSpecs, 4, async (spec, i) => {
    const photo = photos[i % photos.length];
    const r = await call('POST', '/api/contest/submit', {
      ip: COOK_IPS[i % COOK_IPS.length], form: dishForm(spec, ctx.catByName[spec.category], photo),
    });
    const token = r.json?.editUrl ? decodeURIComponent(r.json.editUrl.split('edit=')[1] || '') : null;
    return { spec, photo, status: r.status, token, err: r.json?.error || r.error };
  });
  const bad = sub.filter((s) => s.status < 200 || s.status >= 300 || !s.token);
  check(`every public submit 2xx (${sub.length})`, bad.length === 0,
    bad.length ? `${bad.length} failed, first: ${bad[0].status} ${bad[0].err}` : `${sub.length} accepted with edit tokens`);

  // Resolve tokens to dish ids through the cook's own view.
  let ownLeak = 0; let notPending = 0;
  for (const s of sub.filter((x) => x.token)) {
    const r = await call('GET', `/api/contest/submission?token=${encodeURIComponent(s.token)}`, { ip: COOK_IPS[0] });
    if (r.status !== 200) { notPending += 1; continue; }
    if (walkKeys(r.json).some(([, k]) => k === 'editTokenHash' || k === 'editToken')) ownLeak += 1;
    if (r.json.dish.status !== 'pending') notPending += 1;
    ctx.entries.push({ spec: s.spec, dishId: r.json.dish.id, token: s.token, photo: s.photo, source: 'competitor', sent: { ...s.spec } });
  }
  check('own-entry view resolves every token, status pending', notPending === 0 && ctx.entries.length === sub.length,
    `${ctx.entries.length} resolved, ${notPending} not pending/unresolved`);
  check('own-entry view carries no token material', ownLeak === 0, `${ownLeak} responses with token keys`);

  let pub = await publicState();
  check('pending dishes are invisible to the public', pub.dishes.length === 0, `${pub.dishes.length} public dishes before approval`);

  // Admin approves everything.
  state = await adminState();
  for (const d of state.dishes) if (d.status !== 'approved') state = await admin('dish-approve', { id: d.id });
  check('admin approved every submission', state.dishes.every((d) => d.status === 'approved'),
    `${state.dishes.filter((d) => d.status === 'approved').length}/${state.dishes.length} approved`);

  // 3 cooks edit their text through the token (after approval).
  const editors = ctx.entries.slice(0, 3);
  let editOk = 0;
  for (const [k, e] of editors.entries()) {
    const add = `\n\nUpdated by the cook on the morning of the contest (${k + 1}).`;
    const base = e.sent.recipe;
    const recipe = (base + add).length <= 8000 ? base + add : base.slice(0, base.lastIndexOf('\n', 7000)) + add;
    const name = k === 1 && e.sent.name.length <= 70 ? `${e.sent.name} (Revised)` : e.sent.name;
    const spec = { ...e.sent, recipe, name };
    const r = await call('POST', `/api/contest/submission?token=${encodeURIComponent(e.token)}`, {
      ip: COOK_IPS[(k + 2) % COOK_IPS.length], form: dishForm(spec, ctx.catByName[spec.category], null),
    });
    if (r.status === 200 && r.json.dish.status === 'approved') { editOk += 1; e.sent = spec; }
  }
  state = await adminState();
  pub = await publicState();
  const editsVisible = editors.every((e) => {
    const p = pub.dishes.find((d) => d.id === e.dishId);
    const a = state.dishes.find((d) => d.id === e.dishId);
    return p && p.recipe === e.sent.recipe.trim() && p.name === e.sent.name.trim() && a.editedSinceApproval === true;
  });
  check('3 text edits accepted, dish stays approved', editOk === 3, `${editOk}/3 returned 200 approved`);
  check('text edits visible publicly and flagged editedSinceApproval', editsVisible, editsVisible ? 'yes' : 'public text or flag mismatch');

  // 2 cooks replace their photo after approval.
  const replacers = ctx.entries.slice(3, 5);
  const replaceNotes = [];
  let replaceOk = true;
  for (const [k, e] of replacers.entries()) {
    const before = pub.dishes.find((d) => d.id === e.dishId);
    const oldUrl = before?.photoUrl;
    const newPhoto = photos[4 + k]; // the two EXIF-portrait photos
    const r = await call('POST', `/api/contest/submission?token=${encodeURIComponent(e.token)}`, {
      ip: COOK_IPS[(k + 4) % COOK_IPS.length], form: dishForm(e.sent, ctx.catByName[e.spec.category], newPhoto),
    });
    const ownUrl = r.json?.dish?.photoUrl;
    const st = await adminState();
    const ad = st.dishes.find((d) => d.id === e.dishId);
    const pv = await publicState();
    const inPublic = pv.dishes.find((d) => d.id === e.dishId);
    const exposedNew = pv.dishes.some((d) => d.photoUrl === ownUrl);
    const ok = r.status === 200 && ad.status === 'pending' && !inPublic && !exposedNew && ownUrl && ownUrl !== oldUrl;
    if (!ok) replaceOk = false;
    replaceNotes.push(`${r.status} ${ad.status}, public ${inPublic ? 'still lists it' : 'hides it'}, url ${oldUrl} -> ${ownUrl}`);
    e.photo = newPhoto;
    e.replaced = { oldUrl, newUrl: ownUrl };
  }
  check('photo replace after approval sends dish back to pending, new photo not public', replaceOk, replaceNotes.join('; '));
  for (const e of replacers) state = await admin('dish-approve', { id: e.dishId });
  pub = await publicState();
  const reapproved = replacers.every((e) => pub.dishes.find((d) => d.id === e.dishId)?.photoUrl === e.replaced.newUrl);
  check('re-approved dishes show the replacement photo URL', reapproved,
    replacers.map((e) => pub.dishes.find((d) => d.id === e.dishId)?.photoUrl).join(', '));
  let oldGone = 0;
  for (const e of replacers) {
    if (e.replaced.oldUrl && (await call('GET', e.replaced.oldUrl)).status === 404) oldGone += 1;
  }
  check('superseded photo versions are deleted (old URL 404)', oldGone === replacers.length, `${oldGone}/${replacers.length} old URLs 404`);

  // Admin walk-ins: half with a photo, half without.
  let walkOk = 0;
  for (const [k, spec] of walkins.entries()) {
    const photo = k % 2 === 0 ? photos[k % photos.length] : null;
    const r = await call('POST', '/api/contest/admin/dish-add', { form: dishForm(spec, ctx.catByName[spec.category], photo) });
    if (r.status === 200) {
      walkOk += 1;
      const d = r.json.state.dishes.find((x) => x.name === spec.name && x.cook === spec.cook);
      ctx.entries.push({ spec, dishId: d.id, token: null, photo, source: 'admin', sent: { ...spec } });
    }
  }
  check(`every admin walk-in dish-add 2xx (${walkins.length})`, walkOk === walkins.length, `${walkOk}/${walkins.length}`);

  // Final phase-A checks.
  state = await adminState();
  pub = await publicState();
  const approvedIds = new Set(state.dishes.filter((d) => d.status === 'approved').map((d) => d.id));
  const publicIds = new Set(pub.dishes.map((d) => d.id));
  check('public view lists exactly the approved dishes', approvedIds.size === dishes.length && publicIds.size === approvedIds.size
    && [...approvedIds].every((id) => publicIds.has(id)), `${publicIds.size} public / ${approvedIds.size} approved / ${dishes.length} entered`);
  const leaks = walkKeys(pub).filter(([, k]) => FORBIDDEN_PUBLIC.has(k));
  check('public view has no editToken/editTokenHash/votes/ballots keys', leaks.length === 0,
    leaks.length ? leaks.slice(0, 3).map(([p, k]) => `${p}.${k}`).join(', ') : 'clean');
  const extraKeys = pub.dishes.filter((d) => !isDeepStrictEqual(Object.keys(d).sort(), DISH_PUBLIC_KEYS));
  check('public dish objects carry only the public fields', extraKeys.length === 0, extraKeys.length ? Object.keys(extraKeys[0]).join(',') : 'ok');
  check('admin state carries no token hashes', !walkKeys(state).some(([, k]) => k === 'editTokenHash' || k === 'editToken'), 'checked');

  // Text round-trip (multi-byte and near-cap recipes included).
  const mismatch = [];
  for (const e of ctx.entries) {
    const p = pub.dishes.find((d) => d.id === e.dishId);
    if (!p) { mismatch.push(`${e.spec.name}: missing`); continue; }
    for (const f of ['name', 'cook', 'ingredients', 'recipe']) {
      if (p[f] !== e.sent[f].trim()) mismatch.push(`${e.spec.name}: ${f}${p[f].includes('\r') ? ' (stored CRLF)' : ''}`);
    }
    if (!isDeepStrictEqual([...p.allergens].sort(), [...e.sent.allergens].sort())) mismatch.push(`${e.spec.name}: allergens`);
    if (p.categoryId !== ctx.catByName[e.spec.category]) mismatch.push(`${e.spec.name}: category`);
  }
  const longest = Math.max(...ctx.entries.map((e) => e.sent.recipe.length));
  const multibyte = ctx.entries.filter((e) => /[^\x00-\x7F]/.test(e.sent.name + e.sent.cook + e.sent.recipe)).length;
  check('every field round-trips byte-exact (incl. multi-byte and long recipes)', mismatch.length === 0,
    mismatch.length ? mismatch.slice(0, 4).join('; ') : `${ctx.entries.length} dishes, longest recipe ${longest} chars, ${multibyte} with non-ASCII`);

  // Photos: every photoUrl serves 200 image/webp, oriented correctly.
  const withPhoto = ctx.entries.filter((e) => e.photo);
  const photoProblems = [];
  for (const e of ctx.entries) {
    const p = pub.dishes.find((d) => d.id === e.dishId);
    if (!p) continue;
    if (e.photo && !p.photoUrl) photoProblems.push(`${e.spec.name}: no photoUrl`);
    if (!e.photo && p.photoUrl) photoProblems.push(`${e.spec.name}: unexpected photoUrl`);
    if (!p.photoUrl) continue;
    const r = await call('GET', p.photoUrl, { keepBody: true });
    if (r.status !== 200 || r.ct !== 'image/webp') { photoProblems.push(`${e.spec.name}: ${r.status} ${r.ct}`); continue; }
    const meta = await ctx.sharp(r.buf).metadata();
    const portrait = meta.height > meta.width;
    if (portrait !== e.photo.portrait) photoProblems.push(`${e.spec.name}: ${meta.width}x${meta.height}, expected ${e.photo.portrait ? 'portrait' : 'landscape'}`);
    if (meta.width > 1200) photoProblems.push(`${e.spec.name}: width ${meta.width} > 1200`);
  }
  check('every photoUrl serves 200 image/webp, max 1200 wide, EXIF portrait served upright', photoProblems.length === 0,
    photoProblems.length ? photoProblems.slice(0, 3).join('; ') : `${withPhoto.length} photos checked`);

  // Disk: no temp files left, photo dir holds exactly the current versions.
  const leftovers = listFiles(join(ctx.dir, 'uploads-tmp'));
  const tmpFiles = listFiles(ctx.dir).filter((f) => /\.tmp-\d+-\d+$/.test(f));
  check('no multer temp files left in uploads dir', leftovers.length === 0, `${leftovers.length} files`);
  check('no atomic-write temp files left', tmpFiles.length === 0, `${tmpFiles.length} files`);
  const want = new Set(state.dishes.filter((d) => d.photoVersion > 0).map((d) => `${d.id}-${d.photoVersion}.webp`));
  const have = listFiles(join(ctx.dir, 'photos')).map((f) => f.split('/').pop());
  check('photos dir holds exactly one file per current photo version', have.length === want.size && have.every((f) => want.has(f)),
    `${have.length} files, ${want.size} expected`);
  check('route module default instance stayed inside the sandbox',
    fs.existsSync(join(ctx.dir, 'sandbox-root', 'data', '.uploads-tmp')) && !fs.existsSync(join(ctx.dir, 'sandbox-root', 'data', 'contest')),
    'import-time mkdir landed in <tmp>/sandbox-root/data/.uploads-tmp; the lazy default store never created data/contest');

  ctx.metrics.submission = await metrics();
}

// ---- phase B ------------------------------------------------------------------

async function pageAssets(html) {
  const out = new Set();
  for (const m of html.matchAll(/<(?:script|img)\b[^>]*\ssrc="(\/[^"]+)"/g)) out.add(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*\shref="(\/[^"]+)"/g)) out.add(m[1]);
  return [...out];
}

async function phaseB(ctx) {
  const vrnd = mulberry32(SEED + 2);
  ctx.voters = Array.from({ length: ctx.opts.voters }, () => uuidFrom(vrnd));
  const pub = await publicState();
  const photoUrls = pub.dishes.map((d) => d.photoUrl).filter(Boolean);
  const voteHtml = await call('GET', '/contest/vote', { ip: PHONE_IP, keepBody: true });
  const assets = await pageAssets(voteHtml.buf.toString('utf8'));
  // Follow module imports one level (none today, but a new import must not go untested).
  for (const a of [...assets]) {
    if (!a.endsWith('.js')) continue;
    const js = await call('GET', a, { keepBody: true });
    for (const m of js.buf.toString('utf8').matchAll(/import\s[^'"]*['"]\.\/([^'"]+)['"]/g)) assets.push(`/contest/assets/${m[1]}`);
  }
  const fails = [];
  let photoGets = 0;
  await pool(ctx.voters, 20, async (voterId) => {
    const page = await call('GET', '/contest/vote', { ip: PHONE_IP });
    if (page.status !== 200) fails.push(`vote page ${page.status}`);
    for (const a of assets) {
      const r = await call('GET', a, { ip: PHONE_IP });
      if (r.status !== 200) fails.push(`${a} ${r.status}`);
    }
    const p = await call('GET', '/api/contest/public', { ip: PHONE_IP });
    if (p.status !== 200) fails.push(`public ${p.status}`);
    const b = await call('GET', `/api/contest/my-ballot?voterId=${voterId}`, { ip: PHONE_IP });
    if (b.status !== 200 || Object.keys(b.json?.ballot || {}).length !== 0) fails.push(`my-ballot ${b.status}`);
    await pool(photoUrls, 4, async (u) => {
      const r = await call('GET', u, { ip: PHONE_IP });
      photoGets += 1;
      if (r.status !== 200 || r.ct !== 'image/webp') fails.push(`photo ${r.status}`);
    });
  });
  const tvHtml = await call('GET', '/contest/tv', { keepBody: true });
  const tvAssets = await pageAssets(tvHtml.buf.toString('utf8'));
  for (const a of tvAssets) {
    const r = await call('GET', a);
    if (r.status !== 200) fails.push(`tv ${a} ${r.status}`);
  }
  check(`every phone loaded page, assets (${assets.join(', ')}), public, my-ballot`, !fails.some((f) => !f.startsWith('photo')),
    fails.length ? fails.slice(0, 3).join('; ') : `${ctx.voters.length} phones`);
  check('every photo served to every phone', photoGets === ctx.voters.length * photoUrls.length && !fails.some((f) => f.startsWith('photo')),
    `${photoGets} photo GETs (${ctx.voters.length} phones x ${photoUrls.length} photos)`);
  check(`TV page and its assets load (${tvAssets.join(', ')})`, tvHtml.status === 200 && !fails.some((f) => f.startsWith('tv')), `${tvAssets.length} assets`);
}

// ---- phase C ------------------------------------------------------------------

function weightedPick(ids, weights, rnd, exclude) {
  const pairs = ids.map((id, i) => [id, weights[i]]).filter(([id]) => id !== exclude);
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let x = rnd() * total;
  for (const [id, w] of pairs) { x -= w; if (x <= 0) return id; }
  return pairs[pairs.length - 1][0];
}

async function vote(ctx, voterId, categoryId, dishId, tally) {
  const r = await call('POST', '/api/contest/vote', { ip: PHONE_IP, json: { voterId, categoryId, dishId } });
  if (r.status === 200) {
    const ballot = ctx.expected.get(voterId) || {};
    if (ballot[categoryId] !== dishId) ctx.expectedEvents += 1;
    ballot[categoryId] = dishId;
    ctx.expected.set(voterId, ballot);
    if (!isDeepStrictEqual(r.json.ballot, ballot)) tally.ballotMismatch += 1;
    tally.accepted += 1;
  } else if (r.status === 429) tally.limited += 1;
  else if (r.status === 0) tally.network += 1;
  else { tally.other += 1; tally.otherDetail.push(`${r.status} ${r.json?.error}`); }
  return r;
}

async function phaseC(ctx) {
  const { opts, catIds } = ctx;
  const brnd = mulberry32(SEED + 3);
  const state = await adminState();
  const byCat = Object.fromEntries(catIds.map((c) => [c, shuffle(state.dishes.filter((d) => d.categoryId === c).map((d) => d.id), brnd)]));
  const weights = Object.fromEntries(catIds.map((c) => [c, byCat[c].map((_, i) => 1 / (i + 1) ** 1.3)]));

  await resetMetrics();
  const opened = await admin('open', { minutes: opts.minutes });
  const openAt = Date.now();
  const deadline = Date.parse(opened.deadline);
  ctx.deadline = deadline;
  check('voting opened with the requested deadline', opened.phase === 'open' && Math.abs(deadline - openAt - opts.minutes * 60_000) < 5_000,
    `deadline ${opened.deadline}`);
  const W = deadline - openAt;
  const lastVoteBy = deadline - 5_000;
  const nBurst = Math.round(ctx.voters.length * 0.4);
  const nTwice = Math.round(ctx.voters.length * 0.05);
  const nOnce = Math.round(ctx.voters.length * 0.3);
  const order = shuffle(ctx.voters.map((_, i) => i), brnd);
  const changeCount = new Map();
  order.slice(0, nTwice).forEach((i) => changeCount.set(i, 2));
  order.slice(nTwice, nTwice + nOnce).forEach((i) => changeCount.set(i, 1));

  const plans = ctx.voters.map((voterId, i) => {
    const burst = i < nBurst;
    const arrival = burst ? brnd() * 2_000 : 15_000 + brnd() * Math.max(0, 0.6 * W - 15_000);
    const events = [];
    let t = arrival + 500 + brnd() * 500;
    for (const [k, c] of shuffle(catIds, brnd).entries()) {
      if (k > 0) t += 1_000 + brnd() * 3_000;
      events.push({ t, categoryId: c, dishId: weightedPick(byCat[c], weights[c], brnd) });
    }
    const initialEnd = t;
    const changes = changeCount.get(i) || 0;
    let skipped = 0;
    for (let n = 0; n < changes; n++) {
      const lo = initialEnd + 3_000; const hi = lastVoteBy - openAt;
      if (hi <= lo) { skipped += 1; continue; }
      events.push({ t: lo + brnd() * (hi - lo), categoryId: catIds[Math.floor(brnd() * catIds.length)], change: true });
    }
    events.sort((a, b) => a.t - b.t);
    return { voterId, arrival, events, burst, skipped };
  });
  ctx.plannedChanges = plans.reduce((s, p) => s + p.events.filter((e) => e.change).length, 0);
  ctx.skippedChanges = plans.reduce((s, p) => s + p.skipped, 0);

  const tally = { accepted: 0, limited: 0, network: 0, other: 0, otherDetail: [], ballotMismatch: 0, polls: 0, pollFails: 0, tvPolls: 0 };
  let stopPolling = false;
  let stopTv = false;

  const tv = (async () => {
    while (!stopTv) {
      const r = await call('GET', '/api/contest/public');
      tally.tvPolls += 1;
      if (r.status !== 200) tally.pollFails += 1;
      await sleep(2_000);
    }
  })();

  let burstLast = 0;
  const phones = plans.map(async (plan) => {
    await sleepUntil(openAt + plan.arrival);
    const poller = (async () => {
      while (!stopPolling && Date.now() < deadline) {
        const r = await call('GET', '/api/contest/public', { ip: PHONE_IP });
        tally.polls += 1;
        if (r.status !== 200) tally.pollFails += 1;
        await sleep(10_000);
      }
    })();
    const mb = await call('GET', `/api/contest/my-ballot?voterId=${plan.voterId}`, { ip: PHONE_IP });
    if (mb.status !== 200 || mb.json.phase !== 'open') tally.pollFails += 1;
    for (const ev of plan.events) {
      await sleepUntil(openAt + ev.t);
      let dishId = ev.dishId;
      if (ev.change) {
        const current = (ctx.expected.get(plan.voterId) || {})[ev.categoryId];
        dishId = weightedPick(byCat[ev.categoryId], weights[ev.categoryId], brnd, current);
      }
      await vote(ctx, plan.voterId, ev.categoryId, dishId, tally);
      if (plan.burst && !ev.change) burstLast = Math.max(burstLast, Date.now() - openAt);
    }
    return { poller };
  });
  const pollers = (await Promise.all(phones)).map((p) => p.poller);
  ctx.voteTally = tally;
  const totalVotes = plans.reduce((s, p) => s + p.events.length, 0);
  check(`every vote accepted (${totalVotes} sent)`, tally.accepted === totalVotes,
    `${tally.accepted} accepted, ${tally.limited} x 429, ${tally.network} network, ${tally.other} other${tally.otherDetail.length ? ` (${tally.otherDetail[0]})` : ''}`);
  check('every vote response echoed the expected ballot', tally.ballotMismatch === 0, `${tally.ballotMismatch} mismatches`);
  check('burst phones cast all picks within the first 15 s', burstLast <= 15_500, `last burst pick at ${(burstLast / 1000).toFixed(1)} s`);
  check('every voter recorded a full ballot', [...ctx.expected.values()].filter((b) => Object.keys(b).length === catIds.length).length === ctx.voters.length,
    `${ctx.expected.size} voters with ballots, ${ctx.plannedChanges} changes planned, ${ctx.skippedChanges} skipped for lack of time`);

  // Let the polls run until the deadline, then stop them.
  await sleepUntil(deadline);
  stopPolling = true;
  await Promise.all(pollers);
  ctx.tvPromise = tv;
  ctx.stopTv = () => { stopTv = true; };
  check('every phone and TV poll answered 200', tally.pollFails === 0, `${tally.polls} phone polls, ${tally.tvPolls} TV polls, ${tally.pollFails} failed`);
}

// ---- phase D ------------------------------------------------------------------

async function phaseD(ctx) {
  const drnd = mulberry32(SEED + 4);
  const late = ctx.voters.slice(0, Math.min(10, ctx.voters.length));
  const results = await Promise.all(late.map(async (voterId) => {
    await sleepUntil(ctx.deadline + 1_000 + drnd() * 2_000);
    const ballot = ctx.expected.get(voterId) || {};
    const cat = ctx.catIds[0];
    const state = await adminState();
    const other = state.dishes.find((d) => d.categoryId === cat && d.id !== ballot[cat]);
    const r = await call('POST', '/api/contest/vote', { ip: PHONE_IP, json: { voterId, categoryId: cat, dishId: other.id } });
    return { r, ballot };
  }));
  const bad = results.filter(({ r, ballot }) => !(r.status === 409 && r.json?.phase && r.json.phase !== 'open' && isDeepStrictEqual(r.json.ballot, ballot)));
  check(`${late.length} late votes all refused 409 with phase != open and their ballot`, bad.length === 0,
    bad.length ? `${bad.length} wrong, first: ${bad[0].r.status} phase ${bad[0].r.json?.phase}` : `phase "${results[0]?.r.json?.phase}"`);
  const pub = await publicState();
  check('public phase reads closed after the deadline', pub.phase === 'closed', `phase "${pub.phase}"`);
  ctx.stopTv();
  await ctx.tvPromise;
  ctx.metrics.voting = await metrics();
}

// ---- phase E ------------------------------------------------------------------

function expectedCounts(ctx, state) {
  const counts = new Map(state.dishes.filter((d) => d.status === 'approved').map((d) => [d.id, 0]));
  for (const ballot of ctx.expected.values()) {
    for (const dishId of Object.values(ballot)) counts.set(dishId, (counts.get(dishId) || 0) + 1);
  }
  return counts;
}

async function phaseE(ctx) {
  const state = await adminState();
  const counts = expectedCounts(ctx, state);
  ctx.counts = counts;
  const diffs = [];
  for (const c of state.categories) {
    const rows = state.tally[c.id] || [];
    const dishesInCat = state.dishes.filter((d) => d.categoryId === c.id && d.status === 'approved');
    if (rows.length !== dishesInCat.length) diffs.push(`${c.name}: ${rows.length} rows for ${dishesInCat.length} dishes`);
    for (const row of rows) if (row.votes !== counts.get(row.dishId)) diffs.push(`${row.dishId}: server ${row.votes}, expected ${counts.get(row.dishId)}`);
  }
  check('admin tally matches the parent ballots exactly, per dish', diffs.length === 0,
    diffs.length ? diffs.slice(0, 3).join('; ') : `${counts.size} dishes, ${[...counts.values()].reduce((a, b) => a + b, 0)} votes`);
  const pub = await publicState();
  const voteCount = [...ctx.expected.values()].reduce((s, b) => s + Object.keys(b).length, 0);
  check('public voterCount matches', pub.voterCount === ctx.expected.size, `server ${pub.voterCount}, expected ${ctx.expected.size}`);
  check('public voteCount matches', pub.voteCount === voteCount, `server ${pub.voteCount}, expected ${voteCount}`);
  check('voteEvents matches accepted changes', pub.voteEvents === ctx.expectedEvents, `server ${pub.voteEvents}, expected ${ctx.expectedEvents}`);
  check('stored ballots equal the parent ballots', isDeepStrictEqual(state.ballots, Object.fromEntries(ctx.expected)), `${Object.keys(state.ballots).length} stored`);
}

// ---- phase F ------------------------------------------------------------------

const STEP_FOR_PLACE = { 3: 1, 2: 2, 1: 3 };

/** Independent competition ranking: ties share a place, zero votes never place, place > 3 never shown. */
function expectedReveal(ctx, state) {
  const perCat = state.categories.map((c) => {
    const rows = state.dishes.filter((d) => d.categoryId === c.id && d.status === 'approved')
      .map((d) => ({ dishId: d.id, votes: ctx.counts.get(d.id) || 0 }));
    const placed = rows.map((r) => ({ ...r, place: 1 + rows.filter((o) => o.votes > r.votes).length }))
      .filter((r) => r.votes > 0 && r.place <= 3);
    const steps = [3, 2, 1].map((place) => {
      const held = placed.filter((r) => r.place === place);
      return held.length ? { step: STEP_FOR_PLACE[place], place, dishIds: held.map((r) => r.dishId).sort(), votes: held[0].votes, categoryId: c.id } : null;
    }).filter(Boolean);
    return { categoryId: c.id, steps };
  });
  const sequence = [];
  perCat.forEach((cat, idx) => {
    sequence.push({ categoryIndex: idx, step: 0 });
    for (const s of cat.steps) sequence.push({ categoryIndex: idx, step: s.step });
  });
  return { perCat, sequence };
}

function normRevealed(list) {
  return (list || []).map((r) => ({ categoryId: r.categoryId, place: r.place, dishIds: [...r.dishIds].sort(), votes: r.votes }));
}

function revealLeaks(pub) {
  const leaks = [];
  for (const [path, key] of walkKeys(pub)) {
    if (['editToken', 'editTokenHash', 'ballots', 'ballot', 'tally'].includes(key)) leaks.push(`${path}.${key}`);
    if (['votes', 'place'].includes(key) && !path.startsWith('reveal.revealed')) leaks.push(`${path}.${key}`);
  }
  return leaks;
}

async function phaseF(ctx) {
  const state = await adminState();
  const { perCat, sequence } = expectedReveal(ctx, state);
  const expectedAt = ({ categoryIndex, step }) => normRevealed(perCat[categoryIndex].steps.filter((s) => s.step <= step));
  const problems = [];
  const leakProblems = [];
  const checkStep = async (i, want) => {
    const pub = await publicState();
    const got = normRevealed(pub.reveal?.revealed);
    const exp = expectedAt(want);
    if (pub.phase !== 'revealing') problems.push(`step ${i}: phase ${pub.phase}`);
    else if (pub.reveal.categoryIndex !== want.categoryIndex || pub.reveal.categoryId !== perCat[want.categoryIndex].categoryId) {
      problems.push(`step ${i}: at category ${pub.reveal.categoryIndex}, expected ${want.categoryIndex}`);
    } else if (!isDeepStrictEqual(got, exp)) {
      problems.push(`step ${i} (cat ${want.categoryIndex} step ${want.step}): revealed ${JSON.stringify(got.map((g) => [g.place, g.votes, g.dishIds.length]))}, expected ${JSON.stringify(exp.map((g) => [g.place, g.votes, g.dishIds.length]))}`);
    }
    const leaks = revealLeaks(pub);
    if (leaks.length) leakProblems.push(`step ${i}: ${leaks.slice(0, 2).join(', ')}`);
  };

  let s = await admin('reveal-start');
  if (s.phase !== 'revealing') problems.push(`reveal-start left phase ${s.phase}`);
  await checkStep(0, sequence[0]);
  let nexts = 0;
  for (let i = 1; i < sequence.length; i++) {
    s = await admin('reveal-next');
    nexts += 1;
    if (s.reveal.categoryIndex !== sequence[i].categoryIndex || s.reveal.step !== sequence[i].step) {
      problems.push(`next ${i}: server at (${s.reveal.categoryIndex},${s.reveal.step}), expected (${sequence[i].categoryIndex},${sequence[i].step})`);
    }
    await checkStep(i, sequence[i]);
  }
  s = await admin('reveal-next');
  nexts += 1;
  const pubDone = await publicState();
  const allPlaces = perCat.flatMap((c) => normRevealed(c.steps));
  check('reveal walks every step in the expected order (3rd -> 2nd -> 1st, drum roll first)', problems.length === 0,
    problems.length ? problems.slice(0, 3).join('; ') : `${sequence.length} states, ${nexts} reveal-next calls, places per category ${perCat.map((c) => c.steps.length).join('/')}`);
  check('reveal reaches done and then shows every place in every category', s.phase === 'done' && pubDone.phase === 'done'
    && isDeepStrictEqual(normRevealed(pubDone.reveal.revealed), allPlaces), `phase ${pubDone.phase}, ${pubDone.reveal?.revealed?.length} revealed, ${allPlaces.length} expected`);
  check('TV data never leaks an unrevealed place or vote data', leakProblems.length === 0 && revealLeaks(pubDone).length === 0,
    leakProblems.length ? leakProblems.slice(0, 2).join('; ') : `${sequence.length + 1} states scanned`);
  const after = await call('POST', '/api/contest/admin/reveal-next', { json: {} });
  check('reveal-next after done is refused 409', after.status === 409, `${after.status} ${after.json?.error}`);
  const ties = perCat.flatMap((c) => c.steps).filter((st) => st.dishIds.length > 1).length;
  const unheld = perCat.reduce((n, c) => n + (3 - c.steps.length), 0);
  ctx.revealNotes = `${ties} tied place(s), ${unheld} place step(s) skipped as unheld`;
}

// ---- phase G ------------------------------------------------------------------

async function phaseG(ctx) {
  const before = await adminState();
  await killHarness();
  await startHarness(ctx.dir, ctx.opts.port);
  const after = await adminState();
  const fields = ['title', 'phase', 'reveal', 'ballots', 'dishes', 'categories', 'voteEvents', 'deadline', 'closedAt'];
  const diff = fields.filter((f) => !isDeepStrictEqual(before[f], after[f]));
  check('state survives SIGKILL + restart (phase, reveal, ballots, dishes, ...)', diff.length === 0,
    diff.length ? `differs: ${diff.join(', ')}` : `${fields.length} fields deep-equal`);
  const pub = await publicState();
  const url = pub.dishes.find((d) => d.photoUrl)?.photoUrl;
  const r = url ? await call('GET', url) : { status: 0 };
  check('photos still served after restart', r.status === 200, `${url} -> ${r.status}`);
}

// ---- report ---------------------------------------------------------------------

function fmtMs(n) { return `${n < 10 ? n.toFixed(1) : Math.round(n)} ms`; }
function fmtMb(b) { return b ? `${(b / 1024 / 1024).toFixed(0)} MB` : 'n/a'; }

function endpointRows() {
  return [...stats.entries()].sort((a, b) => b[1].count - a[1].count).map(([key, s]) => {
    const lat = [...s.lat].sort((x, y) => x - y);
    return { key, count: s.count, statuses: Object.entries(s.statuses).map(([k, v]) => `${k}:${v}`).join(' '),
      p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: lat[lat.length - 1] || 0 };
  });
}

function renderReport({ opts, ctx, wallMs, parentPeakRss, photoSizes, aborted }) {
  const failed = checks.filter((c) => !c.pass);
  const L = [];
  L.push('# Contest stress test report', '');
  L.push(`- Result: **${failed.length ? 'FAIL' : 'PASS'}** (${checks.length - failed.length}/${checks.length} checks passed)`);
  L.push(`- Run: ${new Date().toISOString()}, Node ${process.version}, ${os.platform()} ${os.arch()}`);
  L.push(`- Options: --dishes ${opts.dishes} --voters ${opts.voters} --minutes ${opts.minutes} --port ${opts.port}`);
  L.push(`- Wall time: ${(wallMs / 1000).toFixed(1)} s${aborted ? `; aborted after ${aborted}` : ''}`);
  L.push(`- Photos: ${photoSizes.join(', ')}`);
  L.push(`- Requests: ${[...stats.values()].reduce((s, x) => s + x.count, 0)}, network errors ${counters.networkErrors} (${counters.retries} retried), 429s ${counters.status429}, 5xx ${counters.status5xx}`);
  if (ctx.voteTally) L.push(`- Voting: ${ctx.voteTally.accepted} accepted votes, ${ctx.plannedChanges} planned changes (${ctx.skippedChanges} skipped), ${ctx.voteTally.polls} phone polls, ${ctx.voteTally.tvPolls} TV polls`);
  if (ctx.revealNotes) L.push(`- Reveal: ${ctx.revealNotes}`);
  L.push(`- Parent (load generator) peak RSS: ${fmtMb(parentPeakRss)}`, '');

  L.push('## Phases', '', '| Phase | Wall time | Checks | Failed |', '|---|---:|---:|---:|');
  for (const p of phases) {
    const cs = checks.filter((c) => c.phase === p.name);
    L.push(`| ${p.name} | ${p.skipped ? 'skipped' : `${(p.ms / 1000).toFixed(1)} s`} | ${cs.length} | ${cs.filter((c) => !c.pass).length} |`);
  }
  L.push('', '## Harness (server) resources', '', 'Event-loop delay is the excess over the 10 ms sampling interval.', '', '| Window | Peak RSS | Peak heap | Event-loop delay p50 | p99 | max |', '|---|---:|---:|---:|---:|---:|');
  for (const [label, m] of [['Submission (phase A)', ctx.metrics.submission], ['Voting (phases C-D)', ctx.metrics.voting]]) {
    if (!m) { L.push(`| ${label} | n/a | | | | |`); continue; }
    L.push(`| ${label} | ${fmtMb(m.peakRss)} | ${fmtMb(m.peakHeap)} | ${m.eventLoopDelay.p50} ms | ${m.eventLoopDelay.p99} ms | ${m.eventLoopDelay.max} ms |`);
  }
  L.push('', '## Checks', '', '| | Phase | Check | Detail |', '|---|---|---|---|');
  for (const c of checks) L.push(`| ${c.pass ? 'PASS' : '**FAIL**'} | ${c.phase.split('.')[0]} | ${c.name} | ${c.detail.replace(/\|/g, '/')} |`);
  L.push('', '## Endpoints', '', '| Endpoint | Count | Status | p50 | p95 | p99 | max |', '|---|---:|---|---:|---:|---:|---:|');
  for (const r of endpointRows()) L.push(`| \`${r.key}\` | ${r.count} | ${r.statuses} | ${fmtMs(r.p50)} | ${fmtMs(r.p95)} | ${fmtMs(r.p99)} | ${fmtMs(r.max)} |`);
  if (childStderr.length) L.push('', '## Harness stderr (last lines)', '', '```', ...childStderr.slice(-20), '```');
  L.push('');
  return L.join('\n');
}

function renderSummary({ wallMs, ctx, reportPath }) {
  const failed = checks.filter((c) => !c.pass);
  const rows = new Map(endpointRows().map((r) => [r.key, r]));
  const lat = (k) => { const r = rows.get(k); return r ? `p50 ${fmtMs(r.p50)} / p95 ${fmtMs(r.p95)} / max ${fmtMs(r.max)} (n=${r.count})` : 'n/a'; };
  const L = [];
  L.push(`RESULT: ${failed.length ? 'FAIL' : 'PASS'}  ${checks.length - failed.length}/${checks.length} checks passed  (${(wallMs / 1000).toFixed(0)} s wall)`);
  for (const c of failed) L.push(`  FAIL [${c.phase.split('.')[0]}] ${c.name}: ${c.detail}`);
  L.push(`  phases: ${phases.map((p) => `${p.name.split('.')[0]} ${p.skipped ? 'skip' : `${(p.ms / 1000).toFixed(0)}s`}`).join(', ')}`);
  L.push(`  submit  ${lat('POST /api/contest/submit')}`);
  L.push(`  vote    ${lat('POST /api/contest/vote')}`);
  L.push(`  public  ${lat('GET /api/contest/public')}`);
  L.push(`  photo   ${lat('GET /contest/photos/:id-:v.webp')}`);
  const m = ctx.metrics;
  if (m.submission) L.push(`  harness submission: peak RSS ${fmtMb(m.submission.peakRss)}, heap ${fmtMb(m.submission.peakHeap)}, loop delay p99 ${m.submission.eventLoopDelay.p99} ms / max ${m.submission.eventLoopDelay.max} ms`);
  if (m.voting) L.push(`  harness voting:     peak RSS ${fmtMb(m.voting.peakRss)}, heap ${fmtMb(m.voting.peakHeap)}, loop delay p99 ${m.voting.eventLoopDelay.p99} ms / max ${m.voting.eventLoopDelay.max} ms`);
  L.push(`  429s ${counters.status429}, 5xx ${counters.status5xx}, network errors ${counters.networkErrors} (${counters.retries} retried)`);
  L.push(`  report: ${reportPath}`);
  return L.join('\n');
}

// ---- entry ----------------------------------------------------------------------

const argv = process.argv.slice(2);
if (argv[0] === '--harness') {
  runHarness(argv[1], Number(argv[2])).catch((err) => { console.error(err); process.exit(1); });
} else {
  main().catch((err) => {
    console.error(`contest-stress: ${err.stack || err.message}`);
    cleanupSync();
    process.exit(1);
  });
}

