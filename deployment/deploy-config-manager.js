const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const CONFIG_MANAGER_URL = process.env.CONFIG_MANAGER_URL;
const CONFIG_MANAGER_USERNAME = process.env.CONFIG_MANAGER_USERNAME;
const CONFIG_MANAGER_PASS = process.env.CONFIG_MANAGER_PASS;
const CONFIG_ZIP_PATH = process.env.CONFIG_ZIP_PATH || '../partial-config.zip';
const DEPLOY_MODE = (process.env.DEPLOY_MODE || 'merge').toLowerCase();
const DEPLOY_DESCRIPTION =
  process.env.DEPLOY_DESCRIPTION ||
  `Automated partial config deployment from GitHub Actions - Run ${process.env.GITHUB_RUN_ID || 'local'}`;
const HEADLESS = process.env.HEADLESS !== 'false';

const screenshotsDir = path.resolve('screenshots');
const logsDir = path.resolve('logs');

function ensureFolders() {
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
}

function validateInputs() {
  const missing = [];

  if (!CONFIG_MANAGER_URL) missing.push('CONFIG_MANAGER_URL');
  if (!CONFIG_MANAGER_USERNAME) missing.push('CONFIG_MANAGER_USERNAME');
  if (!CONFIG_MANAGER_PASS) missing.push('CONFIG_MANAGER_PASS');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (DEPLOY_MODE !== 'merge') {
    throw new Error(`Unsupported DEPLOY_MODE: ${DEPLOY_MODE}. Currently only merge is automated.`);
  }

  const absoluteZipPath = path.resolve(CONFIG_ZIP_PATH);

  if (!fs.existsSync(absoluteZipPath)) {
    throw new Error(`Config ZIP file not found: ${absoluteZipPath}`);
  }

  return absoluteZipPath;
}

async function screenshot(page, name) {
  const filePath = path.join(screenshotsDir, name);

  try {
    await page.screenshot({
      path: filePath,
      fullPage: true
    });
    console.log(`Screenshot saved: ${filePath}`);
  } catch (error) {
    console.log(`Unable to capture screenshot ${name}: ${error.message}`);
  }
}

function writeLog(name, content) {
  const filePath = path.join(logsDir, name);
  fs.writeFileSync(filePath, content || '', 'utf8');
  console.log(`Log saved: ${filePath}`);
}

async function getBodyTextFromContext(context) {
  try {
    return await context.locator('body').innerText({ timeout: 5000 });
  } catch {
    return '';
  }
}

async function getFullPageText(page) {
  let output = '';

  try {
    output += `MAIN PAGE URL: ${page.url()}\n`;
    output += `MAIN PAGE TITLE: ${await page.title().catch(() => '')}\n\n`;
    output += `MAIN PAGE BODY:\n${await getBodyTextFromContext(page)}\n\n`;
  } catch {
    // Ignore main page text errors
  }

  const frames = page.frames();

  for (let i = 0; i < frames.length; i++) {
    try {
      const frame = frames[i];
      output += `\n---------------- FRAME ${i} ----------------\n`;
      output += `FRAME URL: ${frame.url()}\n`;
      output += `FRAME BODY:\n${await getBodyTextFromContext(frame)}\n`;
    } catch {
      // Ignore frame errors
    }
  }

  return output;
}

async function dumpPageDebugInfo(page, prefix) {
  const debug = {};

  debug.url = page.url();
  debug.title = await page.title().catch(() => '');

  debug.frames = page.frames().map((frame, index) => ({
    index,
    url: frame.url()
  }));

  debug.inputs = await page.locator('input').evaluateAll(inputs =>
    inputs.map(input => ({
      id: input.id || '',
      name: input.name || '',
      type: input.type || '',
      value: input.type === 'password' ? '********' : input.value || '',
      placeholder: input.getAttribute('placeholder') || '',
      className: input.className || '',
      disabled: input.disabled || false,
      outerHTML: input.outerHTML || ''
    }))
  ).catch(error => [{ error: error.message }]);

  debug.buttons = await page.locator('button').evaluateAll(buttons =>
    buttons.map(button => ({
      id: button.id || '',
      name: button.name || '',
      text: button.innerText || button.textContent || '',
      type: button.type || '',
      className: button.className || '',
      disabled: button.disabled || false,
      outerHTML: button.outerHTML || ''
    }))
  ).catch(error => [{ error: error.message }]);

  debug.links = await page.locator('a').evaluateAll(links =>
    links.map(link => ({
      id: link.id || '',
      text: link.innerText || link.textContent || '',
      href: link.href || '',
      className: link.className || '',
      outerHTML: link.outerHTML || ''
    }))
  ).catch(error => [{ error: error.message }]);

  debug.bodyText = await getFullPageText(page);

  writeLog(`${prefix}-debug.json`, JSON.stringify(debug, null, 2));
  writeLog(`${prefix}-page-text.txt`, debug.bodyText);
}

function getSearchContexts(page) {
  const contexts = [page];

  for (const frame of page.frames()) {
    if (frame !== page.mainFrame()) {
      contexts.push(frame);
    }
  }

  return contexts;
}

async function waitForPageStable(page, milliseconds = 3000) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(milliseconds);
}

async function typeLikeUser(page, selector, value, fieldName) {
  const locator = page.locator(selector).first();

  await locator.waitFor({
    state: 'visible',
    timeout: 15000
  });

  await locator.click({ force: true });

  await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
  await locator.press('Backspace').catch(() => {});

  await locator.type(value, {
    delay: 80
  });

  await locator.evaluate(element => {
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    element.blur();
  });

  console.log(`Completed: typed ${fieldName} using selector: ${selector}`);
}

async function fillFirstVisibleInAnyContext(page, selectors, value, stepName) {
  const contexts = getSearchContexts(page);

  for (const context of contexts) {
    for (const selector of selectors) {
      try {
        const locator = context.locator(selector).first();
        await locator.waitFor({ state: 'visible', timeout: 7000 });
        await locator.fill(value);
        console.log(`Completed: ${stepName} using selector: ${selector}`);
        console.log(`Context URL: ${context.url ? context.url() : page.url()}`);
        return;
      } catch {
        // Try next selector/context
      }
    }
  }

  throw new Error(`Failed step: ${stepName}. No matching selector found.`);
}

async function clickFirstVisibleInAnyContext(page, selectors, stepName) {
  const contexts = getSearchContexts(page);

  for (const context of contexts) {
    for (const selector of selectors) {
      try {
        const locator = context.locator(selector).first();
        await locator.waitFor({ state: 'visible', timeout: 7000 });

        try {
          await locator.click({ timeout: 10000 });
        } catch {
          await locator.click({ force: true, timeout: 10000 });
        }

        console.log(`Completed: ${stepName} using selector: ${selector}`);
        console.log(`Context URL: ${context.url ? context.url() : page.url()}`);
        return;
      } catch {
        // Try next selector/context
      }
    }
  }

  throw new Error(`Failed step: ${stepName}. No matching selector found.`);
}

async function clickTextByJavaScriptInAnyContext(page, exactText, stepName) {
  const contexts = getSearchContexts(page);

  for (const context of contexts) {
    try {
      const clicked = await context.evaluate(textToFind => {
        const normalize = value => (value || '').replace(/\s+/g, ' ').trim();

        const elements = Array.from(
          document.querySelectorAll('a, button, input, div, span, td, li')
        );

        const exactCandidate = elements.find(element => {
          const visibleText =
            element.tagName.toLowerCase() === 'input'
              ? element.value
              : element.innerText || element.textContent;

          return normalize(visibleText) === textToFind;
        });

        if (exactCandidate) {
          exactCandidate.click();
          return true;
        }

        const containsCandidate = elements.find(element => {
          const visibleText =
            element.tagName.toLowerCase() === 'input'
              ? element.value
              : element.innerText || element.textContent;

          return normalize(visibleText).includes(textToFind);
        });

        if (containsCandidate) {
          containsCandidate.click();
          return true;
        }

        return false;
      }, exactText);

      if (clicked) {
        console.log(`Completed: ${stepName} using JavaScript text click: ${exactText}`);
        console.log(`Context URL: ${context.url ? context.url() : page.url()}`);
        return;
      }
    } catch {
      // Try next context
    }
  }

  throw new Error(`Failed step: ${stepName}. JavaScript text click did not find: ${exactText}`);
}


async function handleConfigurationLock(page) {

  const pageText = await getFullPageText(page);

  const lockDetected =
    pageText.includes('Configuration Locked') ||
    pageText.includes('Break all locks');

  if (!lockDetected) {

    console.log(
      'No Configuration Lock screen detected.'
    );

    return;
  }

  console.log(
    'Configuration Lock screen detected.'
  );

  await screenshot(
    page,
    '04a-configuration-lock-screen.png'
  );

  writeLog(
    '04a-configuration-lock-screen.txt',
    pageText
  );

  try {

    console.log(
      'Selecting Break all locks option...'
    );

    await page.waitForSelector(
      '#breakLocks',
      {
        timeout: 10000
      }
    );

    await page.locator(
      '#breakLocks'
    ).check({
      force: true
    });

    await screenshot(
      page,
      '04b-break-lock-selected.png'
    );

  } catch (error) {

    throw new Error(
      `Unable to select Break all locks: ${error.message}`
    );

  }



console.log(
    'Clicking Submit button...'
);

await Promise.race([

    page.waitForNavigation({
        timeout: 45000,
        waitUntil: 'domcontentloaded'
    }).catch(() => null),

    page.locator(
        'button.hdm-button'
    ).first().click({
        force: true
    })

]);

console.log(
    'Waiting 40 seconds for lock release...'
);

await page.waitForTimeout(40000);


console.log(
  `Current URL after lock release: ${page.url()}`
);

await screenshot(
  page,
  '04d-after-lock-release-final.png'
);

writeLog(
  '04d-after-lock-release-final.txt',
  await getFullPageText(page)
);


await page.waitForLoadState(
    'domcontentloaded'
).catch(() => {});

await page.waitForLoadState(
    'networkidle',
    { timeout: 30000 }
).catch(() => {});



  await waitForPageStable(
    page,
    5000
  );

  await screenshot(
    page,
    '04c-after-break-lock-submit.png'
  );

  writeLog(
    '04c-after-break-lock-submit.txt',
    await getFullPageText(page)
  );

  await dumpPageDebugInfo(
    page,
    '04c-after-break-lock-submit'
  );

  console.log(
    'Lock screen successfully handled.'
  );
}



/*
async function clickUploadNewConfiguration(page) {
  console.log('Trying to click Upload New Configuration...');

  await dumpPageDebugInfo(page, 'before-click-upload-new-configuration');

  const uploadSelectors = [
    'text=Upload New Configuration',
    'a:has-text("Upload New Configuration")',
    'button:has-text("Upload New Configuration")',
    'td:has-text("Upload New Configuration")',
    'div:has-text("Upload New Configuration")',
    'span:has-text("Upload New Configuration")',
    'li:has-text("Upload New Configuration")',
    '[href*="upload" i]',
    '[onclick*="upload" i]',
    '[id*="upload" i]',
    '[class*="upload" i]'
  ];

  try {
    await clickFirstVisibleInAnyContext(
      page,
      uploadSelectors,
      'click Upload New Configuration'
    );
    return;
  } catch (firstError) {
    console.log(`Normal selector click failed: ${firstError.message}`);
  }

  try {
    await clickTextByJavaScriptInAnyContext(
      page,
      'Upload New Configuration',
      'click Upload New Configuration'
    );
    return;
  } catch (secondError) {
    console.log(`JavaScript text click failed: ${secondError.message}`);
  }

  throw new Error(
    'Unable to click Upload New Configuration. Check before-click-upload-new-configuration-debug.json and screenshots.'
  );
}
*/

async function clickUploadNewConfiguration(page) {

  console.log(
    'Trying to click Upload New Configuration...'
  );

  const pageText =
    await getFullPageText(page);

  writeLog(
    'before-upload-page.txt',
    pageText
  );

  await dumpPageDebugInfo(
    page,
    'before-upload'
  );

  const uploadSelectors = [

    'text=Upload New Configuration',

    'a:has-text("Upload New Configuration")',

    'span:has-text("Upload New Configuration")',

    'td:has-text("Upload New Configuration")',

    'div:has-text("Upload New Configuration")',

    'li:has-text("Upload New Configuration")',

    '[href*="Upload" i]',

    '[href*="upload" i]',

    '[id*="Upload" i]',

    '[id*="upload" i]',

    '[class*="Upload" i]',

    '[class*="upload" i]'
  ];

  try {

    await clickFirstVisibleInAnyContext(
      page,
      uploadSelectors,
      'click Upload New Configuration'
    );

    return;

  } catch (firstError) {

    console.log(
      `Normal selector click failed: ${firstError.message}`
    );

  }

  try {

    await clickTextByJavaScriptInAnyContext(
      page,
      'Upload New Configuration',
      'click Upload New Configuration'
    );

    return;

  } catch (secondError) {

    console.log(
      `JavaScript click failed: ${secondError.message}`
    );

  }

  throw new Error(
    'Unable to locate Upload New Configuration menu.'
  );
}



async function uploadZip(page, absoluteZipPath) {
  const uploadSelectors = [
    'input[type="file"]',
    'input[name*="file" i]',
    'input[id*="file" i]',
    'input[name*="zip" i]',
    'input[id*="zip" i]',
    'input[name*="upload" i]',
    'input[id*="upload" i]'
  ];

  const contexts = getSearchContexts(page);

  for (const context of contexts) {
    for (const selector of uploadSelectors) {
      try {
        const locator = context.locator(selector).first();
        await locator.waitFor({ state: 'attached', timeout: 10000 });
        await locator.setInputFiles(absoluteZipPath);
        console.log(`ZIP file selected using selector: ${selector}`);
        console.log(`Context URL: ${context.url ? context.url() : page.url()}`);
        return;
      } catch {
        // Try next selector/context
      }
    }
  }

  throw new Error('Unable to find file input for ZIP upload.');
}

async function selectMergeOption(page) {
  const mergeSelectors = [
    'label:has-text("Merge active config with config in .zip file")',
    'text=Merge active config with config in .zip file',
    'input[type="radio"][value*="merge" i]',
    'input[type="radio"][name*="merge" i]'
  ];

  const contexts = getSearchContexts(page);

  for (const context of contexts) {
    for (const selector of mergeSelectors) {
      try {
        const locator = context.locator(selector).first();
        await locator.waitFor({ state: 'visible', timeout: 7000 });

        const tagName = await locator.evaluate(el => el.tagName.toLowerCase()).catch(() => '');

        if (tagName === 'input') {
          await locator.check({ force: true });
        } else {
          await locator.click({ force: true });
        }

        console.log(`Merge option selected using selector: ${selector}`);
        console.log(`Context URL: ${context.url ? context.url() : page.url()}`);
        return;
      } catch {
        // Try next selector/context
      }
    }
  }

  console.log('Trying fallback radio-button selection. Selecting first visible radio button as merge option.');

  for (const context of contexts) {
    try {
      const firstRadio = context.locator('input[type="radio"]').first();
      await firstRadio.waitFor({ state: 'visible', timeout: 7000 });
      await firstRadio.check({ force: true });
      console.log('Merge option selected using first available radio button.');
      return;
    } catch {
      // Try next context
    }
  }

  throw new Error('Unable to select Merge option.');
}

async function fillDescriptionIfAvailable(page) {
  const descriptionSelectors = [
    'textarea[name*="description" i]',
    'textarea[id*="description" i]',
    'textarea',
    'input[name*="description" i]',
    'input[id*="description" i]'
  ];

  const contexts = getSearchContexts(page);

  for (const context of contexts) {
    for (const selector of descriptionSelectors) {
      try {
        const locator = context.locator(selector).first();
        await locator.waitFor({ state: 'visible', timeout: 5000 });
        await locator.fill(DEPLOY_DESCRIPTION);
        console.log(`Description filled using selector: ${selector}`);
        console.log(`Context URL: ${context.url ? context.url() : page.url()}`);
        return;
      } catch {
        // Try next selector/context
      }
    }
  }

  console.log('Description field not found. Continuing without description.');
}

function hasFailureText(bodyText) {
  const text = bodyText || '';

  const safeText = text
    .replace(/no errors?/gi, '')
    .replace(/0 errors?/gi, '')
    .replace(/without errors?/gi, '');

  const failurePatterns = [
    /validation failed/i,
    /upload failed/i,
    /deployment failed/i,
    /failed to/i,
    /exception/i,
    /invalid/i,
    /not valid/i,
    /fatal/i,
    /error:/i,
    /\berrors found\b/i
  ];

  return failurePatterns.some(pattern => pattern.test(safeText));
}

async function isCommitVisible(page) {
  const commitSelectors = [
    'button:has-text("Commit")',
    'input[type="submit"][value*="Commit" i]',
    'input[type="button"][value*="Commit" i]',
    'a:has-text("Commit")',
    'text=Commit'
  ];

  const contexts = getSearchContexts(page);

  for (const context of contexts) {
    for (const selector of commitSelectors) {
      try {
        const locator = context.locator(selector).first();
        if (await locator.isVisible({ timeout: 2000 }).catch(() => false)) {
          return true;
        }
      } catch {
        // Try next selector/context
      }
    }
  }

  return false;
}

async function waitForValidation(page) {
  console.log('Waiting for validation result...');

  const validationSuccessPatterns = [
    /check complete/i,
    /validation complete/i,
    /validation successful/i,
    /validated/i,
    /commit/i
  ];

  for (let attempt = 1; attempt <= 90; attempt++) {
    const bodyText = await getFullPageText(page);
    writeLog(`validation-attempt-${attempt}.txt`, bodyText);

    if (hasFailureText(bodyText)) {
      await screenshot(page, 'validation-error.png');
      throw new Error('Validation failed. Failure text found on validation page.');
    }

    if (await isCommitVisible(page)) {
      console.log('Commit button is visible. Validation passed.');
      return;
    }

    if (validationSuccessPatterns.some(pattern => pattern.test(bodyText))) {
      console.log('Validation success text found.');
      return;
    }

    await page.waitForTimeout(3000);
  }

  await screenshot(page, 'validation-timeout.png');
  const finalText = await getFullPageText(page);
  writeLog('validation-timeout-final-page.txt', finalText);

  throw new Error('Timed out waiting for validation result or Commit button.');
}

async function clickCommit(page) {
  const commitSelectors = [
    'button:has-text("Commit")',
    'input[type="submit"][value*="Commit" i]',
    'input[type="button"][value*="Commit" i]',
    'a:has-text("Commit")',
    'text=Commit'
  ];

  try {
    await clickFirstVisibleInAnyContext(page, commitSelectors, 'click Commit');
    return;
  } catch (firstError) {
    console.log(`Normal Commit selector click failed: ${firstError.message}`);
  }

  await clickTextByJavaScriptInAnyContext(page, 'Commit', 'click Commit');
}

async function waitForDeploymentCompletion(page) {
  console.log('Waiting for deployment completion...');

  const successPatterns = [
    /complete/i,
    /completed/i,
    /success/i,
    /successful/i,
    /committed/i
  ];

  for (let attempt = 1; attempt <= 90; attempt++) {
    const bodyText = await getFullPageText(page);
    writeLog(`deployment-attempt-${attempt}.txt`, bodyText);

    if (hasFailureText(bodyText)) {
      await screenshot(page, 'deployment-error.png');
      throw new Error('Deployment failed after commit. Failure text found on page.');
    }

    if (successPatterns.some(pattern => pattern.test(bodyText))) {
      console.log('Deployment success text found.');
      await screenshot(page, 'deployment-complete.png');
      writeLog('deployment-complete.txt', bodyText);
      return;
    }

    await page.waitForTimeout(3000);
  }

  await screenshot(page, 'deployment-final-state.png');
  const finalText = await getFullPageText(page);
  writeLog('deployment-final-state.txt', finalText);

  console.log('Commit was clicked, but completion text was not clearly detected. Please review final screenshot/log.');
}

async function loginToConfigurationManager(page) {
  console.log('Step 1: Opening Configuration Manager login page...');

  await page.goto(CONFIG_MANAGER_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await waitForPageStable(page, 2000);

  await screenshot(page, '01-login-page.png');
  writeLog('01-login-page.txt', await getFullPageText(page));
  await dumpPageDebugInfo(page, '01-login-page');

  console.log('Step 2: Filling login credentials using real typing events...');

  await page.waitForSelector('#kc-form-login', {
    state: 'attached',
    timeout: 15000
  }).catch(() => {
    console.log('Login form #kc-form-login not found immediately. Continuing with field selectors.');
  });

  await typeLikeUser(
    page,
    '#target2',
    CONFIG_MANAGER_USERNAME,
    'username'
  );

  await typeLikeUser(
    page,
    '#login-password',
    CONFIG_MANAGER_PASS,
    'password'
  );

  await screenshot(page, '02-login-filled.png');
  writeLog('02-login-filled.txt', await getFullPageText(page));

  console.log('Checking SIGN IN button state after typing...');

  const signInStateBefore = await page.locator('#sbtbtn').evaluate(button => ({
    id: button.id,
    name: button.name,
    type: button.type,
    value: button.value,
    disabled: button.disabled,
    className: button.className,
    outerHTML: button.outerHTML
  })).catch(error => ({
    error: error.message
  }));

  writeLog('03-signin-button-before-click.json', JSON.stringify(signInStateBefore, null, 2));

  console.log(`SIGN IN disabled before click: ${signInStateBefore.disabled}`);
  console.log(`SIGN IN class before click: ${signInStateBefore.className}`);

  await screenshot(page, '03-before-signin.png');

  console.log('Step 3: Clicking SIGN IN...');

  let loginSubmitted = false;

  try {
    await page.waitForFunction(() => {
      const button = document.querySelector('#sbtbtn');
      return button && !button.disabled;
    }, {
      timeout: 10000
    });

    console.log('SIGN IN button is enabled. Clicking normally...');

    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      page.locator('#sbtbtn').click({ timeout: 15000 })
    ]);

    loginSubmitted = true;
  } catch (enabledClickError) {
    console.log(`SIGN IN button did not become enabled or normal click failed: ${enabledClickError.message}`);
  }

  if (!loginSubmitted) {
    try {
      console.log('Trying extra validation events before forced click...');

      await page.evaluate(() => {
        const username = document.querySelector('#target2');
        const password = document.querySelector('#login-password');
        const button = document.querySelector('#sbtbtn');

        for (const element of [username, password]) {
          if (element) {
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
            element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
            element.blur();
          }
        }

        if (button) {
          button.disabled = false;
          button.removeAttribute('disabled');
          button.className = 'buttonEnabled';
        }
      });

      await screenshot(page, '03b-before-forced-signin.png');

      await Promise.all([
        page.waitForLoadState('domcontentloaded').catch(() => {}),
        page.locator('#sbtbtn').click({ force: true, timeout: 15000 })
      ]);

      loginSubmitted = true;
    } catch (forceClickError) {
      console.log(`Forced SIGN IN click failed: ${forceClickError.message}`);
    }
  }

  if (!loginSubmitted) {
    try {
      console.log('Trying direct form submission using #kc-form-login.submit()...');

      await page.evaluate(() => {
        const username = document.querySelector('#target2');
        const password = document.querySelector('#login-password');
        const button = document.querySelector('#sbtbtn');
        const form = document.querySelector('#kc-form-login');

        for (const element of [username, password]) {
          if (element) {
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
            element.blur();
          }
        }

        if (button) {
          button.disabled = false;
          button.removeAttribute('disabled');
          button.className = 'buttonEnabled';
        }

        if (!form) {
          throw new Error('Login form #kc-form-login not found.');
        }

        form.submit();
      });

      await page.waitForLoadState('domcontentloaded').catch(() => {});
      loginSubmitted = true;
    } catch (formSubmitError) {
      console.log(`Direct form submit failed: ${formSubmitError.message}`);
    }
  }

  await waitForPageStable(page, 7000);

  await screenshot(page, '04-after-login.png');
  writeLog('04-after-login.txt', await getFullPageText(page));
  await dumpPageDebugInfo(page, '04-after-login');

  const currentUrl = page.url();
  const finalText = await getFullPageText(page);

  console.log(`URL after login: ${currentUrl}`);

  const stillOnLoginPage =
    currentUrl.includes('/auth/realms/') ||
    /SIGN IN/i.test(finalText) ||
    (/Username/i.test(finalText) && /Password/i.test(finalText));

  if (stillOnLoginPage) {
    await screenshot(page, 'login-failed-still-on-login-page.png');
    writeLog('login-failed-current-page.txt', finalText);

    throw new Error(
      'Login did not complete successfully. Still on login/auth page after submitting credentials. Check login-failed-still-on-login-page.png and login-failed-current-page.txt.'
    );
  }

  console.log('Login completed successfully. Proceeding to Configuration Manager application page.');
}

async function main() {
  ensureFolders();

  const absoluteZipPath = validateInputs();

  console.log('Starting Nokia Configuration Manager deployment automation...');
  console.log(`Target URL: ${CONFIG_MANAGER_URL}`);
  console.log(`ZIP path: ${absoluteZipPath}`);
  console.log(`Deploy mode: ${DEPLOY_MODE}`);
  console.log(`Headless mode: ${HEADLESS}`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: {
      width: 1920,
      height: 1080
    }
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  page.on('console', message => {
    console.log(`BROWSER CONSOLE [${message.type()}]: ${message.text()}`);
  });

  page.on('pageerror', error => {
    console.log(`BROWSER PAGE ERROR: ${error.message}`);
  });

  page.on('requestfailed', request => {
    console.log(
      `REQUEST FAILED: ${request.method()} ${request.url()} - ${request.failure()?.errorText || ''}`
    );
  });

  try {	
	await loginToConfigurationManager(page);
	console.log(
		'Checking Configuration Lock screen...'
	);
	await handleConfigurationLock(page);
	console.log('Step 4: Clicking Upload New Configuration...');
	await clickUploadNewConfiguration(page);


    await waitForPageStable(page, 3000);

    await screenshot(page, '05-upload-new-configuration-page.png');
    writeLog('05-upload-new-configuration-page.txt', await getFullPageText(page));
    await dumpPageDebugInfo(page, '05-upload-new-configuration-page');

    console.log('Step 5: Selecting ZIP file...');
    await uploadZip(page, absoluteZipPath);

    await screenshot(page, '06-zip-selected.png');
    writeLog('06-zip-selected.txt', await getFullPageText(page));

    console.log('Step 6: Selecting Merge option...');
    await selectMergeOption(page);

    await screenshot(page, '07-merge-option-selected.png');
    writeLog('07-merge-option-selected.txt', await getFullPageText(page));

    console.log('Step 7: Filling description...');
    await fillDescriptionIfAvailable(page);

    await screenshot(page, '08-description-filled.png');
    writeLog('08-description-filled.txt', await getFullPageText(page));

    console.log('Step 8: Clicking Upload...');
    await clickFirstVisibleInAnyContext(
      page,
      [
        'button:has-text("Upload")',
        'input[type="submit"][value*="Upload" i]',
        'input[type="button"][value*="Upload" i]',
        'a:has-text("Upload")',
        'text=Upload'
      ],
      'click Upload'
    );

    await waitForPageStable(page, 3000);

    await screenshot(page, '09-upload-clicked-validation-started.png');
    writeLog('09-validation-started.txt', await getFullPageText(page));
    await dumpPageDebugInfo(page, '09-validation-started');

    console.log('Step 9: Waiting for validation completion...');
    await waitForValidation(page);

    await screenshot(page, '10-validation-complete-commit-visible.png');
    writeLog('10-validation-complete.txt', await getFullPageText(page));

    console.log('Step 10: Clicking Commit...');
    await clickCommit(page);

    await waitForPageStable(page, 3000);

    await screenshot(page, '11-commit-clicked.png');
    writeLog('11-commit-clicked.txt', await getFullPageText(page));
    await dumpPageDebugInfo(page, '11-commit-clicked');

    console.log('Step 11: Waiting for deployment completion...');
    await waitForDeploymentCompletion(page);

    console.log('Deployment automation completed successfully.');
  } catch (error) {
    console.error(`Deployment automation failed: ${error.message}`);

    await screenshot(page, 'error-final-state.png');
    writeLog('error-final-page-text.txt', await getFullPageText(page));
    writeLog('error-message.txt', error.stack || error.message);
    await dumpPageDebugInfo(page, 'error-final-state');

    throw error;
  } finally {
    await browser.close();
  }
}

main();
