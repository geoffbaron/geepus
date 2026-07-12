import { afterAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { isGmailUrlSignedIn, readGmailUnread } from './gmail';

/**
 * Real Playwright, real DOM extraction — no external network or credentials involved (the
 * page content is a hand-built local fixture, not a live Gmail request), so unlike
 * *.live.test.ts this runs in every `npm test`, same category as the project's other
 * real-but-self-contained tests (triggers.test.ts's real filesystem watch, etc.).
 *
 * The fixture mirrors Gmail's real, long-documented accessibility affordances that
 * readGmailUnread targets: `tr[role="row"]`, a sender element carrying a real `email`
 * attribute, and an `aria-label` prefixed "Unread, <sender name>, <subject>, <snippet>"
 * for unread rows. What this test CANNOT verify is that Gmail's actual production markup
 * still matches this contract today — that needs a real signed-in account, which is a
 * one-time step only a human can complete (PLAN2.md N2 design: Geepus never sees the
 * password). Flagged as an explicit gap for Geoff to verify against his own inbox.
 */
const FIXTURE_HTML = `<!doctype html><html><body>
  <table>
    <tbody>
      <tr role="row" aria-label="Unread, Alice Smith, Meeting moved to 3pm, Hi team just a heads up that the meeting moved">
        <td><span email="alice@example.com">Alice Smith</span></td>
        <td>Meeting moved to 3pm</td>
      </tr>
      <tr role="row" aria-label="Bob Jones, Re: invoice, Thanks for confirming the payment went through fine">
        <td><span email="bob@example.com">Bob Jones</span></td>
        <td>Re: invoice</td>
      </tr>
      <tr role="row" aria-label="Unread, Newsletter Team, Weekly digest, Check out this week's top stories and more">
        <td><span email="news@example.com">Newsletter Team</span></td>
        <td>Weekly digest</td>
      </tr>
    </tbody>
  </table>
</body></html>`;

describe('isGmailUrlSignedIn', () => {
  it('is true for real mail.google.com URLs', () => {
    expect(isGmailUrlSignedIn('https://mail.google.com/mail/u/0/#inbox')).toBe(true);
  });

  it('is false when redirected to the accounts.google.com sign-in flow', () => {
    expect(isGmailUrlSignedIn('https://accounts.google.com/ServiceLogin?service=mail')).toBe(false);
  });

  it('is false for an unrelated domain', () => {
    expect(isGmailUrlSignedIn('https://example.com/')).toBe(false);
  });
});

describe('readGmailUnread (real Playwright against a local fixture)', () => {
  let browser: Browser;
  let page: Page;

  afterAll(async () => {
    await page?.close();
    await browser?.close();
  });

  async function loadFixture(): Promise<Page> {
    if (!browser) browser = await chromium.launch({ headless: true });
    if (!page) page = await browser.newPage();
    await page.setContent(FIXTURE_HTML);
    return page;
  }

  it('extracts only the unread rows, skipping read mail', async () => {
    const p = await loadFixture();
    const results = await readGmailUnread(p);
    expect(results).toHaveLength(2);
  });

  it('extracts the sender email address, not the display name, as `from`', async () => {
    const p = await loadFixture();
    const results = await readGmailUnread(p);
    expect(results.map((r) => r.from)).toEqual(['alice@example.com', 'news@example.com']);
  });

  it('correctly separates subject from snippet after stripping the sender name', async () => {
    const p = await loadFixture();
    const results = await readGmailUnread(p);
    expect(results[0]).toMatchObject({
      subject: 'Meeting moved to 3pm',
      snippet: 'Hi team just a heads up that the meeting moved',
    });
    expect(results[1]).toMatchObject({
      subject: 'Weekly digest',
      snippet: "Check out this week's top stories and more",
    });
  });

  it('assigns sequential synthetic uids in row order', async () => {
    const p = await loadFixture();
    const results = await readGmailUnread(p);
    expect(results.map((r) => r.uid)).toEqual([0, 1]);
  });

  it('respects the limit parameter', async () => {
    const p = await loadFixture();
    const results = await readGmailUnread(p, 1);
    expect(results).toHaveLength(1);
  });
});
