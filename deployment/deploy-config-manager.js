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

async function writeLog(name, content) {
  const filePath = path.join(logsDir, name);
  fs.writeFileSync(filePath, content || '', 'utf8');
  console.log(`Log saved: ${filePath}`);
}

async function getBodyText(page) {
  try {
    return await page.locator('body').innerText({ timeout: 5000 });
  } catch {
    return '';
  }
}

async function fillFirstVisible(page, selectors, value, stepName) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: 7000 });
      await locator.fill(value);
      console.log(`Completed: ${stepName} using selector: ${selector}`);
      return selector;
    } catch {
      // Try next selector
    }
  }

  throw new Error(`Failed step: ${stepName}. No matching selector found.`);
}

async function clickFirstVisible(page, selectors, stepName) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: 7000 });
      await locator.click();
      console.log(`Completed: ${stepName} using selector: ${selector}`);
      return selector;
    } catch {
      // Try next selector
    }
  }

  throw new Error(`Failed step: ${stepName}. No matching selector found.`);
}

async function selectMergeOption(page) {
  const mergeSelectors = [
    'label:has-text("Merge active config with config in .zip file")',
    'text=Merge active config with config in .zip file',
    'input[type="radio"][value*="merge" i]',
    'input[type="radio"][name*="merge" i]',
    'input[type="radio"]'
  ];

  for (const selector of mergeSelectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: 7000 });

      const tagName = await locator.evaluate(el => el.tagName.toLowerCase()).catch(() => '');

      if (tagName === 'input') {
        await locator.check();
      } else {
        await locator.click();
      }

      console.log(`Merge option selected using selector: ${selector}`);
      return;
    } catch {
      // Try next selector
    }
  }

  throw new Error('Unable to select Merge option.');
}

async function uploadZip(page, absoluteZipPath) {
  const uploadSelectors = [
    'input[type="file"]',
    'input[name*="file" i]',
    'input[id*="file" i]'
  ];

  for (const selector of uploadSelectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'attached', timeout: 7000 });
      await locator.setInputFiles(absoluteZipPath);
      console.log(`ZIP file selected using selector: ${selector}`);
      return;
    } catch {
      // Try next selector
    }
  }

  throw new Error('Unable to find file input for ZIP upload.');
}

async function fillDescriptionIfAvailable(page) {
  const descriptionSelectors = [
    'textarea[name*="description" i]',
    'textarea[id*="description" i]',
    'textarea',
    'input[name*="description" i]',
    'input[id*="description" i]'
  ];

  for (const selector of descriptionSelectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: 5000 });
      await locator.fill(DEPLOY_DESCRIPTION);
      console.log(`Description filled using selector: ${selector}`);
      return;
    } catch {
      // Try next selector
    }
  }

  console.log('Description field not found. Continuing without description.');
}

async function waitForValidation(page) {
  console.log('Waiting for validation result...');

  const errorPatterns = [
    /error/i,
    /failed/i,
    /failure/i,
    /exception/i,
    /invalid/i,
    /not valid/i,
    /unable/i
  ];

  const validationSuccessPatterns = [
    /check complete/i,
    /validation complete/i,
    /validation successful/i,
    /validated/i,
    /commit/i
  ];

  for (let attempt = 1; attempt <= 90; attempt++) {
    const bodyText = await getBodyText(page);
    await writeLog(`validation-attempt-${attempt}.txt`, bodyText);

    if (errorPatterns.some(pattern => pattern.test(bodyText))) {
      await screenshot(page, 'validation-error.png');
      throw new Error('Validation failed. Error text found on validation page.');
    }

    const commitVisible = await page
      .locator('button:has-text("Commit"), input[type="submit"][value*="Commit" i], input[type="button"][value*="Commit" i], text=Commit')
      .first()
      .isVisible()
      .catch(() => false);

    if (commitVisible) {
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
  const finalText = await getBodyText(page);
  await writeLog('validation-timeout-final-page.txt', finalText);

  throw new Error('Timed out waiting for validation result or Commit button.');
}

async function clickCommit(page) {
  await clickFirstVisible(
    page,
    [
      'button:has-text("Commit")',
      'input[type="submit"][value*="Commit" i]',
      'input[type="button"][value*="Commit" i]',
      'text=Commit'
    ],
    'click Commit'
  );
}

async function waitForDeploymentCompletion(page) {
  console.log('Waiting for deployment completion...');

  const errorPatterns = [
    /error/i,
    /failed/i,
    /failure/i,
    /exception/i,
    /invalid/i
  ];

  const successPatterns = [
    /complete/i,
    /completed/i,
    /success/i,
    /successful/i,
    /committed/i
  ];

  for (let attempt = 1; attempt <= 90; attempt++) {
    const bodyText = await getBodyText(page);
    await writeLog(`deployment-attempt-${attempt}.txt`, bodyText);

    if (errorPatterns.some(pattern => pattern.test(bodyText))) {
      await screenshot(page, 'deployment-error.png');
      throw new Error('Deployment failed after commit. Error text found on page.');
    }

    if (successPatterns.some(pattern => pattern.test(bodyText))) {
      console.log('Deployment success text found.');
      await screenshot(page, 'deployment-complete.png');
      await writeLog('deployment-complete.txt', bodyText);
      return;
    }

    await page.waitForTimeout(3000);
  }

  await screenshot(page, 'deployment-final-state.png');
  const finalText = await getBodyText(page);
  await writeLog('deployment-final-state.txt', finalText);

  console.log('Commit was clicked, but completion text was not clearly detected.');
}

async function main() {
  ensureFolders();
  const absoluteZipPath = validateInputs();

  console.log('Starting Nokia Configuration Manager deployment automation...');
  console.log(`Target URL: ${CONFIG_MANAGER_URL}`);
  console.log(`ZIP path: ${absoluteZipPath}`);
  console.log(`Deploy mode: ${DEPLOY_MODE}`);

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

  try {
    console.log('Step 1: Opening Configuration Manager login page...');
    await page.goto(CONFIG_MANAGER_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await screenshot(page, '01-login-page.png');
    await writeLog('01-login-page.txt', await getBodyText(page));

    console.log('Step 2: Filling login credentials...');

    await fillFirstVisible(
      page,
      [
        'input[name="username"]',
        'input[id="username"]',
        'input[name="user"]',
        'input[id="user"]',
        'input[type="text"]'
      ],
      CONFIG_MANAGER_USERNAME,
      'fill username'
    );

    await fillFirstVisible(
      page,
      [
        'input[name="password"]',
        'input[id="password"]',
        'input[type="password"]'
      ],
      CONFIG_MANAGER_PASS,
      'fill password'
    );

    await screenshot(page, '02-login-filled.png');



    console.log('Step 3: Clicking SIGN IN...');
    

    await page.waitForSelector('#sbtbtn', {
      state: 'visible',
      timeout: 10000
    });
    await screenshot(page, '03-before-signin.png');
    await page.locator('#sbtbtn').click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5000);
    await screenshot(page, '04-after-login.png');



    

    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(3000);

    await screenshot(page, '03-after-login.png');
    await writeLog('03-after-login.txt', await getBodyText(page));

    console.log('Step 4: Clicking Upload New Configuration...');
    await clickFirstVisible(
      page,
      [
        'text=Upload New Configuration',
        'a:has-text("Upload New Configuration")',
        'button:has-text("Upload New Configuration")',
        'td:has-text("Upload New Configuration")',
        'div:has-text("Upload New Configuration")'
      ],
      'click Upload New Configuration'
    );

    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(2000);

    await screenshot(page, '04-upload-new-configuration-page.png');
    await writeLog('04-upload-new-configuration-page.txt', await getBodyText(page));

    console.log('Step 5: Selecting ZIP file...');
    await uploadZip(page, absoluteZipPath);

    await screenshot(page, '05-zip-selected.png');

    console.log('Step 6: Selecting Merge option...');
    await selectMergeOption(page);

    await screenshot(page, '06-merge-option-selected.png');

    console.log('Step 7: Filling description...');
    await fillDescriptionIfAvailable(page);

    await screenshot(page, '07-description-filled.png');

    console.log('Step 8: Clicking Upload...');
    await clickFirstVisible(
      page,
      [
        'button:has-text("Upload")',
        'input[type="submit"][value*="Upload" i]',
        'input[type="button"][value*="Upload" i]',
        'text=Upload'
      ],
      'click Upload'
    );

    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(3000);

    await screenshot(page, '08-upload-clicked-validation-started.png');
    await writeLog('08-validation-started.txt', await getBodyText(page));

    console.log('Step 9: Waiting for validation completion...');
    await waitForValidation(page);

    await screenshot(page, '09-validation-complete-commit-visible.png');

    console.log('Step 10: Clicking Commit...');
    await clickCommit(page);

    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(3000);

    await screenshot(page, '10-commit-clicked.png');
    await writeLog('10-commit-clicked.txt', await getBodyText(page));

    console.log('Step 11: Waiting for deployment completion...');
    await waitForDeploymentCompletion(page);

    console.log('Deployment automation completed successfully.');
  } catch (error) {
    console.error(`Deployment automation failed: ${error.message}`);

    await screenshot(page, 'error-final-state.png');
    await writeLog('error-final-page-text.txt', await getBodyText(page));
    await writeLog('error-message.txt', error.stack || error.message);

    throw error;
  } finally {
    await browser.close();
  }
}

main();
