import assert from "node:assert/strict";
import { chromium } from "playwright";
import { launchBrowser, signInThroughApi, startDemoHarness, waitForAppShell } from "./lib/demo-harness.mjs";

// The create-server wizard: it must never submit before its review step, must not report a field
// as wrong before anyone has typed in it, and must line up with the page around it. Demo mode
// lets every step be walked while the final Create Server stays withheld.

const harness = await startDemoHarness({ dataDirectoryPrefix: "serversentinel-create-wizard-" });
const browser = await launchBrowser(chromium);

async function openWizard(viewport, colorScheme) {
  const context = await browser.newContext({ viewport, colorScheme, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });
  await signInThroughApi(context, harness.baseUrl);
  const page = await context.newPage();
  await page.addInitScript((theme) => {
    localStorage.setItem("serversentinel-active-page", JSON.stringify({ value: "create", savedAt: Date.now() }));
    localStorage.setItem("serversentinel-theme", theme);
    // Enter in a field still fires the form's submit event, which the wizard turns into "next step".
    // What must never happen before the review is a submission made by the Create Server button.
    window.__createSubmits = 0;
    document.addEventListener("submit", (event) => {
      if (/Create Server/.test(event.submitter?.textContent ?? "")) window.__createSubmits += 1;
    }, true);
  }, colorScheme);
  await page.goto(harness.baseUrl, { waitUntil: "domcontentloaded" });
  await waitForAppShell(page);
  await page.locator(".createWizardCard h3", { hasText: "Placement & Identity" }).waitFor();
  return { context, page };
}

const stepHeading = (page) => page.locator(".createWizardCard .modInstallStepIntro h3").textContent();
const submits = (page) => page.evaluate(() => window.__createSubmits);

async function walkToResources(page) {
  await page.locator("#create-display-name").fill("Smoke World");
  await page.locator("#create-display-name").press("Enter");
  await page.locator(".createWizardCard h3", { hasText: "Runtime" }).waitFor();
  // The runtime step enables Next once its version lists have loaded.
  await page.getByRole("button", { name: "Next: Resources & Network" }).click({ timeout: 15_000 });
  await page.locator(".createWizardCard h3", { hasText: "Resources & Network" }).waitFor();
}

try {
  {
    const { context, page } = await openWizard({ width: 1440, height: 900 }, "dark");

    // An untouched form reports nothing; asking to continue does, and focuses the field.
    assert.equal(await page.locator("#create-display-name").getAttribute("aria-invalid"), "false");
    assert.equal(await page.locator("#create-display-name-error").count(), 0, "a blank form must not open with an error");
    await page.getByRole("button", { name: "Next: Runtime" }).click();
    await page.locator("#create-display-name-error").waitFor();
    assert.equal(await stepHeading(page), "Placement & Identity");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "create-display-name");

    // The wizard sits flush with the page header instead of floating in a narrower column.
    const edges = await page.evaluate(() => {
      const card = document.querySelector(".createWizardCard").getBoundingClientRect();
      const title = document.querySelector(".workspaceHeader h2").getBoundingClientRect();
      const cancel = [...document.querySelectorAll(".workspaceActions button")].find((button) => button.textContent.trim() === "Cancel").getBoundingClientRect();
      return { cardLeft: card.left, cardRight: card.right, titleLeft: title.left, cancelRight: cancel.right };
    });
    assert(Math.abs(edges.cardLeft - edges.titleLeft) <= 1, `wizard card should align with the title: ${JSON.stringify(edges)}`);
    assert(Math.abs(edges.cardRight - edges.cancelRight) <= 1, `wizard card should align with Cancel: ${JSON.stringify(edges)}`);

    // Enter advances a step before the review; it never submits.
    await walkToResources(page);
    assert.equal(await submits(page), 0, "Enter before the review step must not create the server");

    const hint = page.locator(".createWizardFooterHint");
    assert.match(await hint.textContent(), /EULA/, "the footer should say why Next is unavailable");
    await page.locator("#create-server-port").press("Enter");
    assert.equal(await stepHeading(page), "Resources & Network", "Enter must not skip incomplete resources");

    // Step 3's Next and step 4's Create Server are separate elements, so the click that opens the
    // review cannot also submit the form.
    await page.getByRole("checkbox", { name: /accept the Minecraft EULA/i }).check();
    const nextToReview = await page.getByRole("button", { name: "Next: Review & Create" }).elementHandle();
    await nextToReview.click();
    await page.locator(".createWizardCard h3", { hasText: "Review & Create" }).waitFor();
    assert.equal(await nextToReview.evaluate((element) => element.isConnected), false, "Next must not be reused as the submit button");
    assert.equal(await submits(page), 0, "opening the review must not create the server");
    assert.equal(await page.locator(".toast, [data-sonner-toast]").count(), 0, "opening the review must not attempt creation");

    const create = page.getByRole("button", { name: "Create Server" });
    assert.equal(await create.isDisabled(), true, "demo mode withholds the final create action");
    assert.match(await page.locator(".createServerBlocked").textContent(), /demo mode/i);

    // Completed steps carry a visible check, and the last title stays beside its number.
    const stepper = await page.evaluate(() => {
      const steps = [...document.querySelectorAll(".createWizardStep")];
      const completed = steps.find((step) => step.classList.contains("completed")).querySelector(":scope > span");
      const style = getComputedStyle(completed);
      const last = steps.at(-1);
      return {
        checkColor: style.color,
        circleColor: style.backgroundColor,
        titleGap: last.querySelector("strong").getBoundingClientRect().left - last.querySelector(":scope > span").getBoundingClientRect().right
      };
    });
    assert.notEqual(stepper.checkColor, stepper.circleColor, `completed check must contrast with its circle: ${JSON.stringify(stepper)}`);
    assert(stepper.titleGap >= 0 && stepper.titleGap <= 16, `last step title should sit beside its number: ${JSON.stringify(stepper)}`);

    // Review values wrap without stray divider lines or indents.
    const reviewIndents = await page.evaluate(() => [...document.querySelectorAll(".reviewSummaryItem")]
      .filter((item) => parseFloat(getComputedStyle(item).borderLeftWidth) > 0 || parseFloat(getComputedStyle(item).paddingLeft) > 0).length);
    assert.equal(reviewIndents, 0, "review items should not carry divider indents");
    await context.close();
  }

  {
    const { context, page } = await openWizard({ width: 390, height: 844 }, "light");
    const layout = await page.evaluate(() => ({
      stepperHeight: document.querySelector(".createWizardStepper").getBoundingClientRect().height,
      overflow: document.documentElement.scrollWidth - window.innerWidth
    }));
    assert(layout.stepperHeight <= 48, `the phone stepper should be a single compact row: ${JSON.stringify(layout)}`);
    assert(layout.overflow <= 0, `the wizard must not scroll sideways: ${JSON.stringify(layout)}`);
    assert.deepEqual(
      await page.locator(".createWizardStep strong").allTextContents(),
      ["Placement & Identity", "Runtime", "Resources & Network", "Review & Create"],
      "step titles stay available to assistive technology"
    );

    await walkToResources(page);
    const bubbles = await page.evaluate(() => {
      const card = document.querySelector(".createWizardCard").getBoundingClientRect();
      return [...document.querySelectorAll(".memoryValueBubble")].map((bubble) => {
        const rect = bubble.getBoundingClientRect();
        return { left: rect.left - card.left, right: card.right - rect.right };
      });
    });
    assert(bubbles.every((bubble) => bubble.left >= 0 && bubble.right >= 0), `memory values must stay inside the card: ${JSON.stringify(bubbles)}`);

    await page.getByRole("checkbox", { name: /accept the Minecraft EULA/i }).check();
    await page.getByRole("button", { name: "Next: Review & Create" }).click();
    await page.locator(".createWizardCard h3", { hasText: "Review & Create" }).waitFor();
    const columns = await page.evaluate(() => getComputedStyle(document.querySelector(".reviewSummaryGrid")).gridTemplateColumns.split(" ").length);
    assert(columns >= 2, `review values should use two columns on a phone, got ${columns}`);
    assert.equal(await submits(page), 0);
    await context.close();
  }

  console.log("Create wizard smoke passed: no submit before review, no error on a blank form, Enter advances steps, aligned layout, visible step state, compact phone progress, and contained memory values.");
} finally {
  await browser.close();
  await harness.stop();
}
