import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, webkit } from 'playwright';
import { startDemoHarness, signInThroughForm, launchBrowser } from './lib/demo-harness.mjs';

const output = process.env.SERVERSENTINEL_MAP_SCREENSHOTS ?? join(tmpdir(), 'serversentinel-map-review');
await mkdir(output, {recursive:true});
const harness = await startDemoHarness({dataDirectoryPrefix:'serversentinel-map-smoke-'});
try {
  for (const [engine, width, theme] of [[chromium,1440,'dark'],[chromium,1440,'light'],[chromium,390,'dark'],[webkit,320,'light']]) {
    const browser=await launchBrowser(engine);
    try {
      const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:theme === 'dark' ? 'no-preference' : 'reduce'});
      await context.addInitScript(theme=>localStorage.setItem('serversentinel-theme',theme),theme);
      const page=await context.newPage();
      await signInThroughForm(page,harness.baseUrl);
      const nav=page.locator('[data-nav-page="players"]');
      if(!await nav.isVisible()) await page.getByRole('button',{name:'Expand navigation'}).click();
      await nav.click();
      await page.locator('.playerMapMarker').first().waitFor();
      await page.getByRole('group',{name:'Players shown on map'}).getByRole('button',{name:'All time',exact:true}).click();
      await page.locator('.playerMap').scrollIntoViewIfNeeded();
      // Sample every animation frame, not just the settled endpoints: the old layout passed
      // endpoint checks while continuously repacking badges during a zoom gesture.
      await page.evaluate(() => {
        window.mapMotionErrors = [];
        const original = new Map();
        let expectedCount;
        const sample = () => {
          const scene = document.querySelector('.playerMapScene').getBoundingClientRect();
          const wrappers = [...document.querySelectorAll('[data-map-mark]')];
          expectedCount ??= wrappers.length;
          if (wrappers.length !== expectedCount) window.mapMotionErrors.push('cluster membership changed during zoom');
          for (const wrapper of wrappers) {
            const key = wrapper.dataset.mapMark;
            const coordinates = `${wrapper.style.left}:${wrapper.style.top}`;
            if (original.has(key) && original.get(key) !== coordinates) window.mapMotionErrors.push(`badge repacked: ${key}`);
            original.set(key, coordinates);
            const marker = wrapper.querySelector('.playerMapMarker').getBoundingClientRect();
            const dx = marker.left + marker.width / 2 - scene.left - scene.width * parseFloat(wrapper.style.left) / 100;
            const dy = marker.top + marker.height / 2 - scene.top - scene.height * parseFloat(wrapper.style.top) / 100;
            if (Math.hypot(dx, dy) > 1.5) window.mapMotionErrors.push(`badge drifted by ${Math.hypot(dx, dy)}px`);
          }
          window.mapMotionFrame = requestAnimationFrame(sample);
        };
        window.mapMotionFrame = requestAnimationFrame(sample);
      });
      let originalLocations;
      for(let step=0;step<5;step++) {
        await page.waitForTimeout(600);
        const result=await page.evaluate(()=>{
          const scene=document.querySelector('.playerMapScene').getBoundingClientRect();
          const server=document.querySelector('.playerMapServer').getBoundingClientRect();
          const dots=[...document.querySelectorAll('.playerMapLocationDot')];
          const locations=[...new Set(dots.map(dot=>`${dot.getAttribute('cx')}:${dot.getAttribute('cy')}`))].sort();
          const heads=[...document.querySelectorAll('.playerMapMarker .playerMapAvatar')];
          const overlaps=[...document.querySelectorAll('.playerMapMarker')].filter(marker=>{
            const r=marker.getBoundingClientRect();
            return r.left < server.right && r.right > server.left && r.top < server.bottom && r.bottom > server.top;
          });
          return {
            locations,
            serverX:(server.left+server.width/2-scene.left)/scene.width,
            serverY:(server.top+server.height/2-scene.top)/scene.height,
            serverSize:server.width,
            overlaps:overlaps.length,
            zoom:new DOMMatrix(getComputedStyle(document.querySelector('.playerMapTransformContent')).transform).a,
            headDrift:heads.some(head=>Math.abs(head.getBoundingClientRect().width/head.offsetWidth-1)>0.04),
            dotDrift:dots.some(dot=>Math.abs(dot.getBoundingClientRect().width-6)>0.15),
            leaders:[...document.querySelectorAll('.playerMapLeader')].every(line=>locations.includes(`${line.getAttribute('x1')}:${line.getAttribute('y1')}`))
          };
        });
        const label=`${engine.name()} ${width}px ${theme} ${Math.round(result.zoom*100)}%`;
        assert(Math.abs(result.serverX-(8.5417+180)/360)<0.001,`${label}: server longitude moved`);
        assert(Math.abs(result.serverY-(90-47.3769)/180)<0.001,`${label}: server latitude moved`);
        assert(Math.abs(result.serverSize-28*Math.SQRT2)<0.1,`${label}: server icon scaled to ${result.serverSize}`);
        assert.equal(result.overlaps,0,`${label}: player badge covers server`);
        assert(!result.headDrift && !result.dotDrift,`${label}: map glyph size changed`);
        assert(result.leaders,`${label}: connector starts away from a location`);
        if(originalLocations) assert.deepEqual(result.locations,originalLocations,`${label}: clustering moved reported locations`);
        originalLocations=result.locations;
        await page.locator('.playerMap').screenshot({path:join(output,`${engine.name()}-${width}-${theme}-${Math.round(result.zoom*100)}.png`)});
        console.log(`map smoke passed: ${label}, ${result.locations.length} fixed locations`);
        const zoomIn=page.getByRole('button',{name:'Zoom in',exact:true});
        if(await zoomIn.isDisabled()) break;
        await zoomIn.click();
      }
      for (let step = 0; step < 2; step++) {
        await page.getByRole('button',{name:'Zoom out',exact:true}).click();
        await page.waitForTimeout(600);
      }
      await page.getByRole('button',{name:'Reset map view'}).click();
      await page.waitForTimeout(600);
      const motionErrors = await page.evaluate(() => {
        cancelAnimationFrame(window.mapMotionFrame);
        return [...new Set(window.mapMotionErrors)];
      });
      assert.deepEqual(motionErrors, [], `${engine.name()} ${width}px: heads shifted during animated zoom/reset`);
      const serverButton = page.locator('.playerMapServer');
      await serverButton.hover();
      const serverPopup = page.getByRole('dialog', {name:'Server location',exact:true});
      await serverPopup.waitFor();
      assert((await serverPopup.textContent()).includes('Zurich, Switzerland'));
      const serverGeometry = await page.evaluate(() => {
        const svg = document.querySelector('.playerMapCanvas');
        const box = document.querySelector('.playerMapServer').getBoundingClientRect();
        const point = new DOMPoint(box.left + box.width/2, box.top + box.height/2).matrixTransform(svg.getScreenCTM().inverse());
        return {x:point.x,y:point.y,onLand:document.querySelector('.playerMapLand').isPointInFill(point)};
      });
      assert(Math.abs(serverGeometry.x - (8.5417+180)*2)<0.1 && Math.abs(serverGeometry.y - (90-47.3769)*2)<0.1, 'Server icon does not align with Zurich on the SVG');
      assert(serverGeometry.onLand, 'Demo server is drawn in the ocean');
      await page.locator('.playerMap').screenshot({path:join(output,`${engine.name()}-${width}-${theme}-server.png`)});
      await serverButton.focus();
      await page.keyboard.press('Escape');
      await serverPopup.waitFor({state:'detached'});
      await serverButton.click();
      await serverPopup.waitFor();
      await page.locator('.playerMapClusterMarker').first().click();
      const popup = page.locator('.playerMapClusterPopup');
      await popup.waitFor();
      const selection = await page.evaluate(() => {
        const frame = document.querySelector('.playerMapFrame').getBoundingClientRect();
        const popup = document.querySelector('.playerMapClusterPopup').getBoundingClientRect();
        const links = [...document.querySelectorAll('.playerMapLocations--active .playerMapLeader')];
        return {
          visibleLinks: links.length > 0 && links.every(link => getComputedStyle(link).opacity === '1'),
          contained: popup.left >= frame.left && popup.right <= frame.right && popup.top >= frame.top && popup.bottom <= frame.bottom
        };
      });
      assert(selection.visibleLinks && selection.contained, `${engine.name()} ${width}px: selected locations or contained popup missing`);
      await page.locator('.playerMap').screenshot({path:join(output,`${engine.name()}-${width}-${theme}-selected.png`)});
      // WebKit does not focus buttons on a pointer click; exercise dismissal from the dialog.
      await popup.focus();
      await page.keyboard.press('Escape');
      await popup.waitFor({state:'detached'});
    } finally {await browser.close();}
  }
  console.log(`Map screenshots: ${output}`);
} finally {await harness.stop();}

