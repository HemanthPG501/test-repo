const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const CONFIG_MANAGER_URL = process.env.CONFIG_MANAGER_URL;
const CONFIG_MANAGER_USERNAME = process.env.CONFIG_MANAGER_USERNAME;
const CONFIG_MANAGER_PASSWORD = process.env.CONFIG_MANAGER_PASSWORD;
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
  if (!CONFIG_MANAGER_PASSWORD) missing.push('CONFIG_MANAGER_PASSWORD');

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
      // Ignore frame text errors
    }
  }

  return output;
}

async function dumpPageDebugInfo(page, prefix) {
  const debug = {
    url: page.url(),
    title: await page.title().catch(() => ''),
    frames: page.frames().map((frame, index) => ({
      index,
      url: frame.url()
    }))
  };

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

function findFrameByUrlPart(page, urlPart) {
  return page.frames().find(frame => frame.url().includes(urlPart));
}

async function waitForFrameByUrlPart(page, urlPart, timeoutMs = 30000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const frame = findFrameByUrlPart(page, urlPart);

    if (frame) {
      return frame;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(`Frame containing URL part "${urlPart}" not found within ${timeoutMs}ms.`);
}

async function findFrameContainingText(page, textPattern) {
  for (const frame of page.frames()) {
    try {
      const bodyText = await getBodyTextFromContext(frame);

      if (textPattern.test(bodyText)) {
        return frame;
      }
    } catch {
      // Continue checking other frames
    }
  }

  return null;
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

  await typeLikeUser(page, '#target2', CONFIG_MANAGER_USERNAME, 'username');
  await typeLikeUser(page, '#login-password', CONFIG_MANAGER_PASSWORD, 'password');

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
  })).catch(error => ({ error: error.message }));

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
      'Login did not complete successfully. Still on login/auth page after submitting credentials.'
    );
  }

  console.log('Login completed successfully. Proceeding to Configuration Manager application page.');
}

async function handleConfigurationLock(page) {
  const pageText = await getFullPageText(page);

  const lockDetected =
    pageText.includes('Configuration Locked') ||
    pageText.includes('Break all locks');

  if (!lockDetected) {
    console.log('No Configuration Lock screen detected.');
    return;
  }

  console.log('Configuration Lock screen detected.');

  await screenshot(page, '04a-configuration-lock-screen.png');
  writeLog('04a-configuration-lock-screen.txt', pageText);

  try {
    console.log('Selecting Break all locks option...');

    await page.waitForSelector('#breakLocks', {
      timeout: 10000
    });

    await page.locator('#breakLocks').check({
      force: true
    });

    await screenshot(page, '04b-break-lock-selected.png');
  } catch (error) {
    throw new Error(`Unable to select Break all locks: ${error.message}`);
  }

  console.log('Clicking Submit button...');

  await page.locator('button.hdm-button').first().click({
    force: true,
    noWaitAfter: true
  });

  console.log('Submit button clicked successfully.');
  console.log('Waiting 45 seconds for lock release...');

  await page.waitForTimeout(45000);

  console.log(`Current URL after lock release: ${page.url()}`);

  await screenshot(page, '04d-after-lock-release-final.png');
  writeLog('04d-after-lock-release-final.txt', await getFullPageText(page));
  await dumpPageDebugInfo(page, '04d-after-lock-release-final');

  console.log('Lock screen successfully handled.');
}

async function clickUploadNewConfiguration(page) {
  console.log('Step 4: Clicking Upload New Configuration...');

  const leftFrame = await waitForFrameByUrlPart(page, 'leftNav', 30000);

  await leftFrame.locator('table.dashboardItem').filter({
    hasText: 'Upload New Configuration'
  }).click({
    force: true,
    noWaitAfter: true
  });

  console.log('Upload New Configuration clicked.');

  await page.waitForTimeout(5000);

  await screenshot(page, '05-upload-menu-clicked.png');
  writeLog('05-upload-menu-clicked.txt', await getFullPageText(page));
}

async function uploadZip(page, absoluteZipPath) {
  console.log('Step 5: Uploading ZIP file...');

  const uploadFrame = await waitForFrameByUrlPart(page, 'zipUploadInput', 30000);

  await uploadFrame.locator('#uploadedFile').waitFor({
    state: 'attached',
    timeout: 30000
  });

  await uploadFrame.locator('#uploadedFile').setInputFiles(absoluteZipPath);

  console.log(`ZIP uploaded: ${absoluteZipPath}`);

  await screenshot(page, '06-zip-selected.png');
  writeLog('06-zip-selected.txt', await getFullPageText(page));
}

async function selectMergeOption(page) {
  console.log('Step 6: Selecting Merge configuration option...');

  const uploadFrame = await waitForFrameByUrlPart(page, 'zipUploadInput', 30000);

  await uploadFrame.locator('#mergeChoice1').check({
    force: true
  });

  await screenshot(page, '07-merge-option-selected.png');
  writeLog('07-merge-option-selected.txt', await getFullPageText(page));

  console.log('Merge option selected.');
}

async function fillDescription(page) {
  console.log('Step 7: Filling deployment description...');

  const uploadFrame = await waitForFrameByUrlPart(page, 'zipUploadInput', 30000);

  await uploadFrame.locator('#description').fill(DEPLOY_DESCRIPTION);

  await screenshot(page, '08-description-filled.png');
  writeLog('08-description-filled.txt', await getFullPageText(page));

  console.log('Description updated.');
}

async function clickUploadButton(page) {
  console.log('Step 8: Clicking Upload button...');

  const uploadFrame = await waitForFrameByUrlPart(page, 'zipUploadInput', 30000);

  await screenshot(page, '09-before-upload-click.png');
  writeLog('09-before-upload-click.txt', await getFullPageText(page));

  await uploadFrame.locator('input[type="submit"][value="Upload"]').click({
    force: true,
    noWaitAfter: true
  });

  console.log('Upload button clicked. Waiting for validation page to load...');

  await page.waitForTimeout(20000);

  await screenshot(page, '09-upload-clicked-validation-started.png');
  writeLog('09-validation-started.txt', await getFullPageText(page));
  await dumpPageDebugInfo(page, '09-validation-started');
}

async function waitForValidation(page) {
  console.log('Step 9: Waiting for validation result...');

  for (let attempt = 1; attempt <= 120; attempt++) {
    const bodyText = await getFullPageText(page);

    writeLog(`validation-attempt-${attempt}.txt`, bodyText);

    const validationFrame = await findFrameContainingText(
      page,
      /Review Changes Before Committing|Check complete|Errors found|Commit|Cancel/i
    );

    const errorsFound = /errors?\s+found/i.test(bodyText);

    if (errorsFound) {
      console.log('Validation failed. Errors found on validation page.');

      await screenshot(page, '10-validation-errors-found.png');
      writeLog('10-validation-errors-found.txt', bodyText);

      if (validationFrame) {
        try {
          console.log('Clicking Cancel because validation errors were found...');

          await validationFrame.locator(
            'input[type="button"][value="Cancel"], input[value="Cancel"], button:has-text("Cancel")'
          ).first().click({
            force: true,
            noWaitAfter: true
          });

          await page.waitForTimeout(10000);

          await screenshot(page, '10a-after-validation-error-cancel.png');
          writeLog('10a-after-validation-error-cancel.txt', await getFullPageText(page));
        } catch (cancelError) {
          console.log(`Unable to click Cancel after validation error: ${cancelError.message}`);
        }
      }

      throw new Error('Validation failed. Errors found. Cancel clicked and logs captured.');
    }

    if (validationFrame) {
      const checkComplete = /check complete/i.test(bodyText);

      const commitVisible = await validationFrame.locator(
        'input[type="submit"][value="Commit"], input[value="Commit"], button:has-text("Commit")'
      ).first().isVisible({
        timeout: 2000
      }).catch(() => false);

      if (checkComplete && commitVisible) {
        console.log('Validation completed successfully. Commit button is visible.');

        await screenshot(page, '10-validation-complete-no-errors.png');
        writeLog('10-validation-complete-no-errors.txt', bodyText);

        return validationFrame;
      }
    }

    await page.waitForTimeout(3000);
  }

  await screenshot(page, '10-validation-timeout.png');
  writeLog('10-validation-timeout.txt', await getFullPageText(page));

  throw new Error('Timed out waiting for validation completion.');
}

async function extractDeploymentLog(page, commitFrame, fileName) {
  console.log('Extracting deployment log from configLogDiv...');

  if (!commitFrame) {
    throw new Error('Commit result frame not found. Cannot extract deployment log.');
  }

  try {
    await commitFrame.locator(
      'a[onclick*="showLog"], a:has-text("Show Log")'
    ).first().click({
      force: true
    }).catch(() => {
      console.log('Show Log link click skipped or not required.');
    });

    await page.waitForTimeout(2000);
  } catch {
    console.log('Unable to click Show Log. Trying to extract configLogDiv directly.');
  }

  const logContent = await commitFrame.evaluate(() => {
    const logDiv = document.querySelector('#configLogDiv');

    if (!logDiv) {
      return '';
    }

    const html = logDiv.innerHTML || '';

    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim();
  });

  const finalLog =
    logContent ||
    'configLogDiv was not found or no deployment log content was available.';

  writeLog(fileName, finalLog);

  console.log(`Deployment log saved in logs folder: ${fileName}`);

  return finalLog;
}

async function getCommitStatus(commitFrame) {
  return await commitFrame.evaluate(() => {
    function isVisible(element) {
      if (!element) {
        return false;
      }

      const style = window.getComputedStyle(element);

      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0'
      );
    }

    const statusIds = [
      'overallStatusInProgress',
      'overallStatusComplete',
      'overallStatusCompletedWithErrors',
      'overallStatusCompletedWithPublishErrors',
      'overallStatusFailed',
      'overallStatusActivationFailedMsg',
      'overallStatusJMSExceptionMsg'
    ];

    for (const id of statusIds) {
      const element = document.getElementById(id);

      if (element && isVisible(element)) {
        return {
          id,
          text: (element.innerText || element.textContent || '').trim()
        };
      }
    }

    return {
      id: '',
      text: document.body ? document.body.innerText : ''
    };
  });
}

async function waitForFinalDeploymentStatus(page) {
  console.log('Waiting for final deployment status after Commit...');

  for (let attempt = 1; attempt <= 60; attempt++) {
    const commitFrame = await findFrameContainingText(
      page,
      /Commit Changes|Overall Progress|In Progress|Complete|Completed with Errors|Complete, not published/i
    );

    const fullText = await getFullPageText(page);

    writeLog(`deployment-final-status-attempt-${attempt}.txt`, fullText);

    if (!commitFrame) {
      console.log(`Commit status frame not found on attempt ${attempt}.`);

      await page.waitForTimeout(5000);
      continue;
    }

    const status = await getCommitStatus(commitFrame);

    console.log(`Deployment status attempt ${attempt}: ${status.id} - ${status.text}`);

    if (status.id === 'overallStatusInProgress') {
      await screenshot(page, `12-deployment-in-progress-${attempt}.png`);

      await page.waitForTimeout(5000);
      continue;
    }

    if (status.id === 'overallStatusComplete') {
      console.log('Deployment completed successfully.');

      await screenshot(page, '13-deployment-complete.png');

      const logText = await extractDeploymentLog(
        page,
        commitFrame,
        'final-deployment-log-success.txt'
      );

      writeLog('13-deployment-complete-page.txt', fullText);

      return {
        status,
        logText,
        commitFrame
      };
    }

    if (
      status.id === 'overallStatusCompletedWithErrors' ||
      status.id === 'overallStatusCompletedWithPublishErrors' ||
      status.id === 'overallStatusFailed' ||
      status.id === 'overallStatusActivationFailedMsg' ||
      status.id === 'overallStatusJMSExceptionMsg'
    ) {
      console.log(`Deployment failed or completed with errors: ${status.id}`);

      await screenshot(page, '13-deployment-failed-or-error.png');

      const logText = await extractDeploymentLog(
        page,
        commitFrame,
        'final-deployment-log-failed.txt'
      );

      writeLog('13-deployment-failed-page.txt', fullText);

      throw new Error(
        `Deployment failed or completed with errors. Status: ${status.id}. Text: ${status.text}. Deployment log saved as final-deployment-log-failed.txt.`
      );
    }

    await page.waitForTimeout(5000);
  }

  await screenshot(page, '13-deployment-status-timeout.png');
  writeLog('13-deployment-status-timeout.txt', await getFullPageText(page));

  throw new Error('Timed out waiting for final deployment status.');
}

async function clickBackToApplicationConfiguration(page, commitFrame) {
  console.log('Clicking Back to Application Configuration...');

  if (!commitFrame) {
    throw new Error('Commit result frame not found. Cannot click Back to Application Configuration.');
  }

  await screenshot(page, '14-before-back-to-application-configuration.png');

  await commitFrame.locator(
    'a:has-text("Back to Application Configuration"), a[href*="mainFrameSet"]'
  ).first().click({
    force: true,
    noWaitAfter: true
  });

  await page.waitForTimeout(10000);

  await screenshot(page, '15-after-back-to-application-configuration.png');
  writeLog('15-after-back-to-application-configuration.txt', await getFullPageText(page));

  console.log('Returned to Application Configuration page.');
}

async function commitValidatedConfiguration(page, validationFrame) {
  if (!validationFrame) {
    throw new Error('Validation frame not found. Cannot click Commit.');
  }

  console.log('Step 10: Clicking Commit button...');

  await screenshot(page, '11-before-commit-click.png');
  writeLog('11-before-commit-click.txt', await getFullPageText(page));

  await validationFrame.locator(
    'input[type="submit"][value="Commit"], input[value="Commit"], button:has-text("Commit")'
  ).first().click({
    force: true,
    noWaitAfter: true
  });

  console.log('Commit button clicked. Waiting 60 seconds for navigation/commit processing...');

  await page.waitForTimeout(60000);

  await screenshot(page, '12-after-commit-initial-wait.png');
  writeLog('12-after-commit-initial-wait.txt', await getFullPageText(page));
  await dumpPageDebugInfo(page, '12-after-commit-initial-wait');

  console.log('Commit click and initial wait completed.');
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

    console.log('Checking Configuration Lock screen...');
    await handleConfigurationLock(page);

    await clickUploadNewConfiguration(page);

    await waitForPageStable(page, 3000);

    await screenshot(page, '05-upload-new-configuration-page.png');
    writeLog('05-upload-new-configuration-page.txt', await getFullPageText(page));
    await dumpPageDebugInfo(page, '05-upload-new-configuration-page');

    await uploadZip(page, absoluteZipPath);
    await selectMergeOption(page);
    await fillDescription(page);
    await clickUploadButton(page);

    const validationFrame = await waitForValidation(page);

    await commitValidatedConfiguration(page, validationFrame);

    const deploymentResult = await waitForFinalDeploymentStatus(page);

    await clickBackToApplicationConfiguration(
      page,
      deploymentResult.commitFrame
    );

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
