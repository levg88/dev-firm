import { CompleteOptions, LLMClient, LLMResponse, contentAsText, response } from './base';

/** Offline provider used for demos and tests. */
export class MockClient extends LLMClient {
  provider = 'mock';
  model = 'mock';
  reason: string;

  constructor(reason = '') {
    super();
    this.reason = reason;
  }

  async complete(messages: Record<string, any>[], options: CompleteOptions = {}): Promise<LLMResponse> {
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => contentAsText(message.content))
      .join('\n');
    if (system.includes('OUTPUT JSON') || options.jsonMode) {
      return response({ text: '{}' });
    }
    return response({
      text:
        '# Mock agent output\n\n' +
        'No model provider is configured, so this artifact was produced by ' +
        "the offline mock. Choose a provider and API key in the web app's " +
        'Settings for real agent output.',
    });
  }
}
