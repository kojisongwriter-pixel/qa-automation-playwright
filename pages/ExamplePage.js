const { BasePage } = require('@kojisongwriter-pixel/qa-platform-core');

class ExamplePage extends BasePage {
  constructor(page) {
    super(page);
    this.heading = page.getByRole('heading').first();
  }

  async goto() {
    await this.navigate('/');
    await this.waitForPageLoad();
  }

  async isLoaded() {
    return this.heading.isVisible();
  }
}

module.exports = { ExamplePage };
