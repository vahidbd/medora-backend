import { describe, expect, it } from 'vitest';
import { publishProblems, wordingProblems } from '../../src/modules/help-centre/rules.js';

/** What help centre wording may hold (docs/decisions/support.md SUP16). */
describe('help centre wording', () => {
  it('takes Markdown headings, lists, emphasis and safe links', () => {
    const body = [
      '## How delivery works',
      '',
      'Orders leave within **two business days**.',
      '',
      '- Track it from [your account](/account/orders)',
      '- Read our [delivery terms](https://kestrel.example/terms#delivery) or [jump below](#returns)',
      '',
      '[policy]: https://kestrel.example/policy',
    ].join('\n');
    expect(wordingProblems(body)).toEqual([]);
  });

  it.each([
    ['raw HTML', 'Call us <b>now</b>'],
    ['an HTML comment', 'Hidden <!-- note -->'],
    ['a script', '<script>alert(1)</script>'],
  ])('refuses %s', (_, text) => {
    expect(wordingProblems(text)).toEqual(['Remove the HTML: write headings, lists and links in Markdown']);
  });

  it('refuses images, which would need a new origin', () => {
    expect(wordingProblems('![Our team](https://kestrel.example/team.png)')).toContain('Remove the image: the help centre shows text only');
  });

  it.each([
    ['plain http', '[terms](http://kestrel.example/terms)'],
    ['a script link', '[click](javascript:alert(1))'],
    ['another site without a scheme', '[terms](//elsewhere.example/terms)'],
    ['a reference to a data address', '[x]: data:text/html,hi'],
    ['an email link', '[write](mailto:care@kestrel.example)'],
  ])('refuses %s', (_, text) => {
    expect(wordingProblems(text)).toEqual(['Links must start with https:// or point to one of your own pages, like /help']);
  });

  it('checks every public text, naming each problem once', () => {
    expect(publishProblems(['Hi <i>there</i>', 'A <b>summary</b>', 'Fine.'])).toEqual(['Remove the HTML: write headings, lists and links in Markdown']);
  });
});
