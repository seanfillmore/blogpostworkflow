// Public recipes page: every approved dish with its ingredients, recipe and recipe link.
// All dish text is cook-entered, so it only ever reaches the page via textContent.

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

/** Only http(s) links are ever made clickable. */
function webLink(value) {
  try {
    const u = new URL(String(value || '').trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch { return ''; }
}

// Dishes entered before the link was saved separately carry it as the last line of the
// imported recipe ("Source: https://…"); use that when there is no saved link.
const SOURCE_LINE = /^Source:\s*(\S+)\s*$/im;
function linkFor(dish) {
  const saved = webLink(dish.recipeUrl);
  if (saved) return saved;
  const m = SOURCE_LINE.exec(dish.recipe || '');
  return m ? webLink(m[1]) : '';
}

function slug(text, i) {
  return `cat-${i}-${String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function dishCard(dish, labels) {
  const card = el('article', 'recipe');
  if (dish.photoUrl) {
    const img = el('img');
    img.src = dish.photoUrl;
    img.alt = dish.name;
    img.loading = 'lazy';
    card.append(img);
  }
  const body = el('div', 'recipe-body');
  body.append(el('h3', null, dish.name), el('p', 'recipe-cook', `by ${dish.cook}`));

  const badges = el('ul', 'badges');
  for (const key of dish.allergens || []) {
    badges.append(el('li', key === 'none' ? 'badge badge-none' : 'badge', key === 'none' ? 'No listed allergens' : (labels[key] || key)));
  }
  body.append(badges);

  const link = linkFor(dish);
  if (link) {
    const a = el('a', 'recipe-link', 'Open the original recipe');
    a.href = link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';
    body.append(a);
  }

  body.append(el('h4', null, 'Ingredients'), el('p', 'prose', dish.ingredients || ''));
  body.append(el('h4', null, 'Recipe'));
  const recipe = (dish.recipe || '').trim();
  if (recipe) body.append(el('p', 'prose', recipe));
  else body.append(el('p', 'recipe-none', link ? 'The cook shared the link above instead of typing the steps.' : 'The cook did not add the steps.'));

  card.append(body);
  return card;
}

async function load() {
  let data;
  let labels = {};
  try {
    [data, labels] = await Promise.all([
      getJson('/api/contest/public'),
      getJson('/api/contest/submission-form').then((f) => (f && f.allergens) || {}).catch(() => ({})),
    ]);
  } catch {
    $('loading').hidden = true;
    $('error').textContent = 'We could not load the recipes. Please refresh the page to try again.';
    $('error').hidden = false;
    return;
  }
  $('loading').hidden = true;
  if (data.title) {
    $('title').textContent = `${data.title}: the recipes`;
    document.title = `${data.title}: the recipes`;
  }
  const box = $('recipes');
  const nav = $('recipe-nav');
  box.replaceChildren();
  nav.replaceChildren();
  const dishes = data.dishes || [];
  if (!dishes.length) {
    box.append(el('p', 'small', 'No recipes yet. Check back soon.'));
    return;
  }
  data.categories.forEach((cat, i) => {
    const inCat = dishes.filter((d) => d.categoryId === cat.id);
    if (!inCat.length) return;
    const id = slug(cat.name, i);
    const section = el('section', 'recipe-cat');
    section.id = id;
    section.append(el('h2', null, cat.name));
    for (const dish of inCat) section.append(dishCard(dish, labels));
    box.append(section);
    const a = el('a', null, cat.name);
    a.href = `#${id}`;
    nav.append(a);
  });
}

$('print-btn').addEventListener('click', () => window.print());
load();
