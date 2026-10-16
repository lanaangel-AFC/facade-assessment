// Browser check: start the app with OPENAI_BASE_URL/WORD_LIBRARY_API_BASE pointing at dictation-mock.mjs (port 5999), save an OpenAI key in Settings, create project 1, then run.
const { chromium } = require('playwright');
const B = 'http://127.0.0.1:5056'; const M = 'http://127.0.0.1:5999';
const res = []; const ok = (n, c, d = '') => { res.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' ' + d}`); };
(async () => {
  const br = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=/tmp/wp7tone.wav'] });
  for (const vp of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const tag = vp.width < 500 ? 'phone' : 'desktop';
    const ctx = await br.newContext({ viewport: vp, permissions: ['microphone'], hasTouch: vp.width < 500 });
    const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(`${B}/#/projects/1/observations/new`); await pg.waitForSelector('[data-testid=button-dictate]', { timeout: 20000 }); await pg.waitForTimeout(1500);
    const mic = pg.locator('[data-testid=button-dictate]').first();
    await mic.scrollIntoViewIfNeeded();
    await mic.click(); await pg.waitForTimeout(400);
    ok(`${tag}: recording with the word library`, (await mic.getAttribute('data-dictation-mode')) === 'library');
    await pg.waitForTimeout(2000); await mic.click();
    let spin = false; for (let i = 0; i < 50; i++) { if ((await mic.getAttribute('data-transcribing')) === 'true') spin = true; const v = await pg.evaluate(() => [...document.querySelectorAll('textarea,input')].some((t) => t.value.includes('Sealant has failed'))); if (v) break; await pg.waitForTimeout(100); }
    ok(`${tag}: transcribing shown`, spin);
    ok(`${tag}: text inserted in the field`, await pg.evaluate(() => [...document.querySelectorAll('textarea,input')].some((t) => t.value === 'Sealant has failed at the façade joint.')));
    ok(`${tag}: add-a-word button shown`, await pg.locator('[data-testid=button-add-word]').isVisible());
    await pg.screenshot({ path: `/tmp/fa_${tag}.png` });
    ok(`${tag}: no sideways scrolling`, await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    ok(`${tag}: no page errors`, errs.length === 0, errs.join('|'));
    await ctx.close();
  }
  await br.close(); console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
