import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact';

describe('redactSecrets', () => {
  // The exact class of leak found in this project's own prototype settings.json.
  it('redacts a real-shaped Anthropic API key', () => {
    const text = 'my key is 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';
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain('mWqHDSC56xLqZIgTfvEUHkJoJR6acYBSpsxUoirf4L3X7kdSLwb');
    expect(redacted).toContain('[REDACTED_API_KEY]');
  });

  it('redacts an OpenAI-style key', () => {
    expect(redactSecrets('key: sk-proj-abcdefghijklmnopqrstuvwxyz1234567890')).toContain('[REDACTED_API_KEY]');
  });

  it('redacts an OpenRouter key', () => {
    expect(redactSecrets('OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnop')).toContain('[REDACTED_API_KEY]');
  });

  it('redacts an AWS access key', () => {
    expect(redactSecrets('aws key AKIAIOSFODNN7EXAMPLE here')).toContain('[REDACTED_AWS_KEY]');
  });

  it('redacts a Bearer token', () => {
    const redacted = redactSecrets('Authorization: Bearer abc123def456ghi789');
    expect(redacted).not.toContain('abc123def456ghi789');
    expect(redacted).toContain('[REDACTED_TOKEN]');
  });

  it('redacts a PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(`here is my key:\n${pem}`)).toContain('[REDACTED_PRIVATE_KEY]');
  });

  it('redacts a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ';
    expect(redactSecrets(`token: ${jwt}`)).toContain('[REDACTED_JWT]');
  });

  it('redacts a generic password= assignment', () => {
    const redacted = redactSecrets('db_password=hunter2rocks');
    expect(redacted).not.toContain('hunter2rocks');
    expect(redacted).toContain('[REDACTED]');
  });

  it('leaves ordinary text untouched', () => {
    const text = 'The user asked me to check the weather in Blaine, WA.';
    expect(redactSecrets(text)).toBe(text);
  });

  it('leaves short, non-secret-shaped words alone', () => {
    expect(redactSecrets('the key to success is practice')).toBe('the key to success is practice');
  });
});
