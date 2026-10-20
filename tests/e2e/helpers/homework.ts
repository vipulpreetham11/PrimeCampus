import { expect, test, type Locator, type Page } from '@playwright/test';

// Evidence for the intermittent "homework saved but not listed on the lesson page" failure (M2X / M3 /
// M4 full runs). Records every save_homework / list_homework request and response of a page with
// times, whether the response carries the run's homework, and the page text — attached on failure.

export function recordHomeworkTraffic(page: Page, marker: string) {
  const lines: string[] = [];
  const t0 = Date.now();
  const at = () => `+${String(Date.now() - t0).padStart(6, ' ')}ms`;
  const fnOf = (url: string) => url.split('/').at(-1);
  page.on('request', (r) => {
    if (!/\/rpc\/(save_homework|list_homework)$/.test(r.url())) return;
    lines.push(`${at()} → ${fnOf(r.url())} ${(r.postData() ?? '').slice(0, 300)}`);
  });
  page.on('requestfailed', (r) => {
    if (!/\/rpc\/(save_homework|list_homework)$/.test(r.url())) return;
    lines.push(`${at()} ✗ ${fnOf(r.url())} failed: ${r.failure()?.errorText ?? '?'}`);
  });
  page.on('response', (r) => {
    if (!/\/rpc\/(save_homework|list_homework)$/.test(r.url())) return;
    void r.text().then(
      (b) =>
        lines.push(
          `${at()} ← ${fnOf(r.url())} ${r.status()} has run: ${b.includes(marker)} ${b.slice(0, 200)}`,
        ),
      () => lines.push(`${at()} ← ${fnOf(r.url())} ${r.status()} (no body)`),
    );
  });
  return {
    lines,
    /** Wait (bounded) for the item; on failure attach the traffic and the page text, then rethrow. */
    async expectListed(item: Locator, pageTestId = 'lesson-page', timeout = 30_000) {
      try {
        await expect(item).toBeVisible({ timeout });
      } catch (e) {
        const shown = await page
          .getByTestId(pageTestId)
          .innerText()
          .catch(() => '(page element missing)');
        await test.info().attach('homework not listed', {
          body: `${lines.join('\n')}\n--- page ---\n${shown}`,
          contentType: 'text/plain',
        });
        throw e;
      }
    },
  };
}
