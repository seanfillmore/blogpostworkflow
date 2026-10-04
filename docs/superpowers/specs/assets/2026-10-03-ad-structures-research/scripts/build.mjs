import fs from 'fs';
const s = JSON.parse(fs.readFileSync('selected.json'));
// [format, what the image shows, compliance flag or '']
const T = {
1:['product shot (flat/group)','Four labelled jars of Tallow & Honey Balm (scent variants) stacked on a soft backdrop, logo above; no headline',''],
2:['testimonial/review card (fake-tweet) + before/after-of-skin','Verified-badge "tweet" from a named woman claiming tallow smooths wrinkles and boosts collagen, above a two-photo face before/after','collagen/wrinkle-removal claims + face before/after'],
3:['testimonial/review card (comment screenshot)','Product jar with illustrated farmer label; below it a Facebook comment screenshot ("friends think I got botox") with reaction count','botox comparison implies drug-like effect'],
4:['testimonial/review card (fake-tweet, highlighted)','Verified-badge "tweet" with lime-highlighted phrases ("fine lines disappeared", "10 years younger"), product jar + 100% money-back badge','fine-lines-disappeared / age-reversal claims'],
5:['ingredient/benefit callout','Quote headline about compliments; jar on honeycomb with three arrowed benefit pills','"tighten skin", "reduce fine lines", "lighten dark spots" = drug-adjacent structure/function claims'],
6:['authority/mechanism diagram (skin before/after illustration)','"Johns Hopkins Research" banner over a damaged vs repaired skin-barrier illustration with a 94%-of-women statistic','borrowed institutional authority + "repaired barrier"; unverifiable research attribution'],
7:['offer/bundle (overstock story)','Hand holding the jar in a warehouse full of pallets; headline "We made too much..."; pill with Buy 2 Get 1 / Buy 3 Get 2',''],
8:['before/after-of-skin (face)','Split selfie: red, rough-looking face vs clear smiling face in the same bathroom','face before/after implies treatment of redness/rosacea-like condition'],
9:['testimonial/review card + offer band','"Best buy this year." headline, Facebook comment screenshot, two jars (one open), yellow "ALL BUNDLES UP TO 35% OFF" band',''],
10:['offer/bundle (labelled kit)','"Tallow Winter Set SAVE €52": five products laid out with hand-drawn arrows naming each, yellow discount band',''],
11:['us-vs-them / objection humour (split)','Left: raw beef fat "face cream they think we sell"; right: hand holding the finished jar "face cream we actually sell"',''],
12:['product longevity before/after (jar, not skin)','"DAY 1" full jar vs "DAY 132" partly used jar; footer states the objection "Too expensive. Way too small."',''],
13:['social proof count + product-in-hand lifestyle','"A POT OF GOLD" / 7000+ happy customers on 6 continents, hand holding jar in front of daffodils',''],
14:['text-heavy wordplay + product','Serif headline "Our return policy is simple. Dry skin will never return." over a single jar on a plain ground','mild: implies permanent result'],
15:['us-vs-them comparison (split)','Ours (light, natural texture) vs THEIRS (grey sludge) with check/x lists',''],
16:['testimonial/review card','5-star "I love it" review card about fine lines after one week, jar + open jar texture','fine-lines/aging-reversal claim in quote'],
17:['ingredient callout + curiosity hook','Italic headline "People think my mom gets Botox... she doesn\'t"; four ingredient icons; jar with whipped texture; CTA pill','botox comparison'],
18:['founder story (family/market stall collage)','Two family founders smiling at a market stall, plus product close-ups (whipped tallow, baby butter cream, keychain)',''],
19:['texture smear/swatch','Finger scooping thick cream from a jar; serif headline "Velvety hydration that melts in."',''],
20:['testimonial/review card + offer + texture','5-star quote headline "The best body moisturizer...", 20%-off code bar, arm with lotion swipe, bottle',''],
21:['offer (free gift with purchase)','"FREE full-sized body serum" + free-shipping threshold, value icons, two serum bottles',''],
22:['UGC selfie/story native','Hand with red nails holding jar, Instagram-story caption about wrinkles and dry skin, "shop my storefront" sticker','"deep repair of fine lines and wrinkles" in copy'],
23:['product-on-model lifestyle (mother + baby)','Collage: mother with toddler, jar close-up, toddler applying balm, text "Protect their perfect skin and Repair your damaged skin"','"repair damaged skin"'],
24:['problem image (cracked heels) with product','"GOODBYE WINTER SKIN", jar plus two circled photos of a cracked heel and a smooth heel','heel before/after is borderline (cosmetic dryness is OK; fissures/healing is not)'],
25:['us-vs-them comparison (split)','Our jar vs "Other tallow" tube with check/x pills (first colostrum, made in USA, grass-fed, seed-oil free vs made in China, generic claims)',''],
26:['us-vs-them comparison chart (3-column)','"Sure, tallow balm is great... but we made it better": table of conventional skincare vs basic tallow balm vs ours with checks/crosses',''],
27:['problem image (raw, unbranded)','Unpolished phone photo of a child\'s arm covered in rough bumps; no text, no product (persona advertorial)','condition-led (keratosis pilaris / eczema story); fake-persona page'],
28:['problem image (raw, unbranded)','Close phone photo of bumpy upper arm; no text, no product (persona advertorial)','condition-led (keratosis pilaris); fake-persona page'],
30:['text-heavy native post (lo-fi handwritten sign)','Handwritten cardboard sign "Non-Woke Skincare (Just take 1 each)" with a tin on it',''],
31:['text-heavy native (news/notice style)','"Tariff Notice: prices will NOT be increasing..." banner over photos of tins, merch and a woman with a tin',''],
32:['meme + attribute list','Product tin with flag/attribute list over a parliament-brawl meme captioned "WOULD"',''],
33:['testimonial/UGC collage','Review screenshot (5 stars, Canada flag) + smiling-skin photo + tin; caption "MY skin transformation in 3 weeks"','"skin is now clear" acne-adjacent review'],
34:['meme us-vs-them','"Woman yelling at cat" meme: Sephora moisturizer vs F-Balm tin',''],
35:['meme (edgy/political)','John Wayne in front of US flag with crude men\'s-tallow headline and tin',''],
36:['curiosity hook comparison (vs procedure)','"Beef Tallow Better for Women than Botox?" collage: injection, whipped tallow, highland cow','botox comparison'],
37:['product in environment (founder-story copy)','Tin lying in dry prairie grass; copy is a first-person farm-girl founder story',''],
38:['before/after-of-skin (hands)','Split: cracked, dirty working hand vs clean smooth hand','copy cites "cracking and bleeding" hands; healing implication'],
39:['dupe/comparison + product','"Inspired by BACCARAT 540" headline, 4.8/5 rating, body butter jar next to a red perfume bottle',''],
40:['offer (BOGO graphic)','Bubble-letter "Buy 2 Get 1 Free" over a 3D shopping cart holding three jars',''],
41:['product shot with benefit headline','"Graceful aging begins with what you put on your skin", two jars (one open showing whipped texture)',''],
42:['ingredient/benefit callout + testimonial','"It\'s time to switch to tallow" with four benefit icons, review speech-bubble, finger in whipped balm','"anti-aging from free radical protection"'],
43:['ingredient callout + texture','Yellow balm smear on the left; ingredient list with circular ingredient photos and one-line benefit each',''],
44:['UGC native (product in hand, odd subject)','Hand holding tin in front of a horse\'s face; caption sticker "Your skin might not need more products..."',''],
45:['product-on-model (application)','Close crop of a leg with a hand spreading lotion; vertical serif product-name text',''],
46:['offer/bundle','"Plump, smooth hydrated skin" headline, body oil + body cream bottles, "Bundle & Save $33" badge',''],
47:['testimonial + texture','Customer quote headline about 6th order and 71-year-old skin; jar with swirled butter texture',''],
48:['UGC-style product-in-hand','Hand holding open balm jar (lid off), orange NEW badge',''],
49:['product-on-model + claim callouts','Shirtless male model hugging his arm, "Dry Skin", "48hr moisture", pump bottle','"strengthen skin moisture barrier" (OTC-skin-protectant brand)'],
50:['ingredient callout (question headline)','"Why is it important for your balm to have astaxanthin?" over an orange balm in a jar with three claim pills','"improves elasticity", "6000x stronger than vitamin C"'],
};
const out = [];
s.forEach((x, i) => {
  if (!T[i]) return; // 0 = soap bar (not lotion), 29 = collagen spray (not lotion)
  out.push({ brand: x.brand, pageName: x.page_name, pageUrl: x.pageUrl, adLibraryUrl: x.adLibraryUrl, startDate: x.startDate, daysRunning: x.daysRunning,
    primaryText: x.primaryText, headline: x.headline, cta: x.cta, screenshot: x.screenshot, format: T[i][0], imageShows: T[i][1], complianceFlag: T[i][2] || null,
    displayFormat: x.displayFormat, versionsInLibrary: x.versions, linkUrl: x.linkUrl });
});
out.sort((a, b) => b.daysRunning - a.daysRunning);
fs.writeFileSync('ads.json', JSON.stringify(out, null, 2));
// remove screenshots for dropped ads
for (const i of [0, 29]) { try { fs.unlinkSync(s[i].screenshot); } catch {} }
console.log(out.length);
