const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const CONFIG_MANAGER_URL = process.env.CONFIG_MANAGER_URL;
const CONFIG_MANAGER_USERNAME = process.env.CONFIG_MANAGER_USERNAME;
const CONFIG_MANAGER_PASSWORD = process.env.CONFIG_MANAGER_PASSWORD;
const CONFIG_ZIP_PATH = process.env.CONFIG_ZIP_PATH || 'partial-config.zip';
const DEPLOYMENT_DESCRIPTION =
  process.env.DEPLOYMENT_DESCRIPTION ||
  `Automated partial config deployment from GitHub Actions - Run ID: ${process.env.GITHUB_RUN_ID || 'local'}`;

const HEADLESS = process.env.HEADLESS !== 'false';

function requiredEnv(name, value) {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

async function safeScreenshot(page, name) {
  try {
    await page.screenshot({
      path: name,
      fullPage: true
    });
    console.log(`Screenshot captured: ${name}`);
  } catch (error) {
    console.log(`Unable to capture screenshot ${name}: ${error.message}`);
  }
}

async function getPageText(page) {
  try {
    return await page.locator('body').innerText({ timeout: 5000 });
  } catch {
    return '';
  }
}

async function clickFirstAvailable(page, locators, stepName) {
  for (const locator of locators) {
    try {
      const element = page.locator(locator).first();
      await element.waitFor({ state: 'visible', timeout: 5000 });
      await element.click();
      console.log(`Completed step: ${stepName} using locator: ${locator}`);
      return;
    } catch {
      // Try next locator
    }
  }

  throw new Error(`Unable to complete step: ${stepName}. None of the locators worked.`);
}

async function fillFirstAvailable(page, locators, value, stepName) {
  for (const locator of locators) {
    try {
      const element = page.locator(locator).first();
      await element.waitFor({ state: 'visible', timeout: 5000 });
      await element.fill(value);
      console.log(`Completed step: ${stepName} using locator: ${locator}`);
      return;
    } catch {
      // Try next locator
    }
  }

  throw new Error(`Unable to complete step: ${stepName}. None of the locators worked.`);
}

async function chooseMergeConfig(page) {
  const mergeLocators = [
    'label:has-text("Merge")',
    'label:has-text("merge")',
    'text=Merge the config',
    'text=Merge Config',
    'text=merge the config',
    'input[type="radio"][value="merge" i]',
    'input[type="radio"][value*="merge" i]',
    'input[name*="merge" i]',
    'input[id*="merge" i]'
  ];

  for (const locator of mergeLocators) {
    try {
      const element = page.locator(locator).first();
      await element.waitFor({ state: 'visible', timeout: 5000 });

      const tagName = await element.evaluate(el => el.tagName.toLowerCase()).catch(() => '');

      if (tagName === 'input') {
        await element.check();
      } else {
        await element.click();
      }

      console.log(`Selected merge config option using locator: ${locator}`);
      return;
    } catch {
      // Try next locator
    }
  }

  throw new Error('Unable to select Merge Config option. Please inspect the radio button selector.');
}

async function uploadZipFile(page, zipPath) {
  const absoluteZipPath = path.resolve(zipPath);

  if (!fs.existsSync(absoluteZipPath)) {
    throw new Error(`Config ZIP file not found: ${absoluteZipPath}`);
  }

  const fileInputLocators = [
    'input[type="file"]',
    'input[name*="file" i]',
    'input[id*="file" i]',
    'input[name*="upload" i]',
    'input[id*="upload" i]'
  ];

  for (const locator of fileInputLocators) {
    try {
      const input = page.locator(locator).first();
      await input.waitFor({ state: 'attached', timeout: 5000 });
      await input.setInputFiles(absoluteZipPath);
      console.log(`Uploaded ZIP file using locator: ${locator}`);
      return;
    } catch {
      // Try next locator
    }
  }

  throw new Error('Unable to find file upload input. Please inspect the upload page HTML.');
}

async function waitForValidationAndCommitButton(page) {
  console.log('Waiting for validation result...');

  const failurePatterns = [
    /error/i,
    /failed/i,
    /failure/i,
    /invalid/i,
    /exception/i
  ];

  const successPatterns = [
    /check complete/i,
    /validation complete/i,
    /validation successful/i,
    /success/i,
    /commit/i
  ];

  for (let attempt = 1; attempt <= 60; attempt++) {
    const bodyText = await getPageText(page);

    if (failurePatterns.some(pattern => pattern.test(bodyText))) {
      console.log('Validation page text:');
      console.log(bodyText);
      throw new Error('Validation failed. Please check validation logs in screenshot/artifact.');
    }

    const commitButtonVisible = await page
      .locator('button:has-text("Commit"), input[type="button"][value*="Commit" i], input[type="submit"][value*="Commit" i], text=Commit')
      .first()
      .isVisible()
      .catch(() => false);

    if (commitButtonVisible || successPatterns.some(pattern => pattern.test(bodyText))) {
      console.log('Validation looks successful or Commit button is visible.');
      return;
    }

    await page.waitForTimeout(5000);
  }

  const finalText = await getPageText(page);
  console.log('Final page text after waiting for validation:');
  console.log(finalText);

  throw new Error('Timed out waiting for validation completion or Commit button.');
}

async function main() {
  requiredEnv('CONFIG_MANAGER_URL', CONFIG_MANAGER_URL);
  requiredEnv('CONFIG_MANAGER_USERNAME', CONFIG_MANAGER_USERNAME);
  requiredEnv('CONFIG_MANAGER_PASSWORD', CONFIG_MANAGER_PASSWORD);

  console.log('Starting automated partial config deployment...');
  console.log(`Target URL: ${CONFIG_MANAGER_URL}`);
  console.log(`ZIP file path: ${CONFIG_ZIP_PATH}`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: {
      width: 1920,
      height: 1080
    }
  });

  const page = await context.newPage();

  try {
    page.setDefaultTimeout(30000);

    console.log('Opening Configuration Manager...');
    await page.goto(CONFIG_MANAGER_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await safeScreenshot(page, '01-login-page.png');

    console.log('Filling login details...');

    await fillFirstAvailable(
      page,
      [
        'input[name="username"]',
        'input[name="user"]',
        'input[id="username"]',
        'input[id="user"]',
        'input[type="text"]',
        'input[name*="login" i]',
        'input[id*="login" i]'
      ],
      CONFIG_MANAGER_USERNAME,
      'fill username'
    );

    await fillFirstAvailable(
      page,
      [
        'input[name="password"]',
        'input[id="password"]',
        'input[type="password"]'
      ],
      CONFIG_MANAGER_PASSWORD,
      'fill password'
    );

    await clickFirstAvailable(
      page,
      [
        'button:has-text("Login")',
        'button:has-text("Log In")',
        'input[type="submit"][value*="Login" i]',
        'input[type="button"][value*="Login" i]',
        'text=Login',
        'text=Log In'
      ],
      'click login'
    );

    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    await safeScreenshot(page, '02-after-login.png');

    console.log('Navigating to Application tab if required...');

    try {
      await clickFirstAvailable(
        page,
        [
          'text=Application',
          'a:has-text("Application")',
          'button:has-text("Application")'
        ],
        'click Application tab'
      );

      await page.waitForTimeout(2000);
    } catch {
      console.log('Application tab may already be selected. Continuing...');
    }

    console.log('Opening Upload New Configuration page...');

    await clickFirstAvailable(
      page,
      [
        'text=Upload New Configuration',
        'a:has-text("Upload New Configuration")',
        'button:has-text("Upload New Configuration")'
      ],
      'click Upload New Configuration'
    );

    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    await safeScreenshot(page, '03-upload-page.png');

    console.log('Uploading partial config ZIP...');
    await uploadZipFile(page, CONFIG_ZIP_PATH);

    console.log('Selecting Merge Config option...');
    await chooseMergeConfig(page);

    console.log('Filling deployment description...');

    try {
      await fillFirstAvailable(
        page,
        [
          'textarea[name*="description" i]',
          'textarea[id*="description" i]',
          'input[name*="description" i]',
          'input[id*="description" i]',
          'textarea',
          'input[type="text"]'
        ],
        DEPLOYMENT_DESCRIPTION,
        'fill deployment description'
      );
    } catch {
      console.log('Description field not found. Continuing without description...');
    }

    await safeScreenshot(page, '04-before-upload.png');

    console.log('Clicking Upload button...');

    await clickFirstAvailable(
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
    await page.waitForTimeout(5000);

    await safeScreenshot(page, '05-validation-started.png');

    await waitForValidationAndCommitButton(page);

    await safeScreenshot(page, '06-validation-complete.png');

    console.log('Clicking Commit button...');

    await clickFirstAvailable(
      page,
      [
        'button:has-text("Commit")',
        'input[type="submit"][value*="Commit" i]',
        'input[type="button"][value*="Commit" i]',
        'text=Commit'
      ],
      'click Commit'
    );

    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(5000);

    await safeScreenshot(page, '07-after-commit.png');

    console.log('Waiting for deployment completion...');

    for (let attempt = 1; attempt <= 60; attempt++) {
      const bodyText = await getPageText(page);

      if (/error|failed|failure|exception/i.test(bodyText)) {
        console.log('Deployment page text:');
        console.log(bodyText);
        throw new Error('Deployment failed after commit. Please check logs and screenshot.');
      }

      if (/complete|completed|success|successful/i.test(bodyText)) {
        console.log('Deployment completed successfully.');
        console.log('Final page text:');
        console.log(bodyText);
        await safeScreenshot(page, '08-deployment-complete.png');
        return;
      }

      await page.waitForTimeout(5000);
    }

    const finalText = await getPageText(page);
    console.log('Final page text:');
    console.log(finalText);

    await safeScreenshot(page, '08-final-state.png');

    console.log('Commit was clicked, but completion text was not clearly detected. Please review screenshot/artifacts.');
  } catch (error) {
    console.error(`Deployment automation failed: ${error.message}`);
    await safeScreenshot(page, 'error-state.png');

    const pageText = await getPageText(page);
    console.log('Page text at failure:');
    console.log(pageText);

    throw error;
  } finally {
    await browser.close();
  }
}

main();