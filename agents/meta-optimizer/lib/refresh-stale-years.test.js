import { refreshStaleYears } from './refresh-stale-years.js';

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ FAIL:', msg); process.exitCode = 1; return; }
  console.log('  ✓', msg);
}

const currentYear = new Date().getFullYear();
const lastYear = currentYear - 1;
const twoYearsAgo = currentYear - 2;

console.log('refreshStaleYears()\n');

// Basic stale year replacement
{
  const { text, changed } = refreshStaleYears(`Best Aluminum Free Deodorant in ${lastYear}`);
  assert(text === `Best Aluminum Free Deodorant in ${currentYear}`, 'replaces last year in title');
  assert(changed === true, 'changed flag is true when replacement happened');
}

// Multiple stale years in same string
{
  const { text, changed } = refreshStaleYears(`Best of ${twoYearsAgo} & ${lastYear} Comparison`);
  assert(text === `Best of ${currentYear} & ${currentYear} Comparison`, 'replaces multiple stale years');
  assert(changed === true, 'changed when multiple replacements');
}

// Current year is untouched
{
  const { text, changed } = refreshStaleYears(`Best Deodorant in ${currentYear}`);
  assert(text === `Best Deodorant in ${currentYear}`, 'leaves current year alone');
  assert(changed === false, 'changed is false when no replacement');
}

// Future years are untouched (don't invent fresh content)
{
  const nextYear = currentYear + 1;
  const { text, changed } = refreshStaleYears(`Planned for ${nextYear}`);
  assert(text === `Planned for ${nextYear}`, 'leaves future years alone');
  assert(changed === false, 'changed is false for future years');
}

// No years at all
{
  const { text, changed } = refreshStaleYears('Best Natural Deodorant Review');
  assert(text === 'Best Natural Deodorant Review', 'leaves year-free text alone');
  assert(changed === false, 'changed is false when no years present');
}

// Empty/null input
{
  const { text, changed } = refreshStaleYears('');
  assert(text === '', 'handles empty string');
  assert(changed === false, 'no change on empty');
}
{
  const { text, changed } = refreshStaleYears(null);
  assert(text === '', 'handles null input');
  assert(changed === false, 'no change on null');
}

// Year inside HTML tag (summary_html case)
{
  const { text, changed } = refreshStaleYears(`<p>Updated for ${lastYear} with new picks.</p>`);
  assert(text === `<p>Updated for ${currentYear} with new picks.</p>`, 'replaces year inside HTML');
  assert(changed === true, 'changed when year is in HTML');
}

// Year as part of a longer number (e.g., phone number 2025551234) is NOT matched
{
  const { text, changed } = refreshStaleYears(`Call 2025551234 today`);
  assert(text === `Call 2025551234 today`, 'does not match year inside longer digit run');
  assert(changed === false, 'changed is false when "year" is part of longer number');
}

// Year 2019 and older are NOT touched (treated as historical references)
{
  const { text, changed } = refreshStaleYears(`A 2018 study showed`);
  assert(text === `A 2018 study showed`, 'leaves pre-2020 years alone (historical)');
  assert(changed === false, 'changed is false for pre-2020 years');
}

console.log('\nDone.');
