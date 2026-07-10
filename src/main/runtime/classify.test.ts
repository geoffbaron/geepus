import { describe, expect, it } from 'vitest';
import { classifyObjective } from './classify';

describe('classifyObjective', () => {
  // Regression tests for AGENT_LOOP_INVESTIGATION.md bug #3: inferRunTaskClass
  // defaulted anything unmatched to 'build', which then demanded test/browser
  // verification a simple lookup could never produce.
  describe('regression: never defaults to build (investigation bug #3)', () => {
    it.each([
      "what's the weather in Blaine",
      'check the weather',
      'what time is it in Tokyo',
      'find the cheapest flights to Denver',
      'how much is a gallon of milk',
    ])('"%s" is not classified as build', (objective) => {
      expect(classifyObjective(objective)).not.toBe('build');
    });

    it('the canonical failing case classifies as lookup specifically', () => {
      expect(classifyObjective("what's the weather in Blaine")).toBe('lookup');
      expect(classifyObjective('check the weather')).toBe('lookup');
    });

    it('an empty or unrecognizable objective defaults to chat, not build', () => {
      expect(classifyObjective('')).toBe('chat');
      expect(classifyObjective('hello there')).toBe('chat');
      expect(classifyObjective('thanks!')).toBe('chat');
    });
  });

  describe('build', () => {
    it.each([
      'build a todo app in React',
      'create a website for my bakery',
      'implement the login feature',
      'refactor this function',
      'fix the bug in the parser',
      'write a script to rename files',
    ])('"%s" -> build', (objective) => {
      expect(classifyObjective(objective)).toBe('build');
    });
  });

  describe('browse', () => {
    it.each([
      'buy this shirt on the store website',
      'sign up for the newsletter',
      'add this to cart and checkout',
      'book a table for two tonight',
    ])('"%s" -> browse', (objective) => {
      expect(classifyObjective(objective)).toBe('browse');
    });
  });

  describe('operate', () => {
    it.each(['restart the print spooler', 'install the latest update', 'schedule a daily backup', 'clean up old downloads'])(
      '"%s" -> operate',
      (objective) => {
        expect(classifyObjective(objective)).toBe('operate');
      },
    );
  });

  describe('research', () => {
    it.each([
      'research the best budget laptops under $500',
      'compare electric cars for commuting',
      'summarize this week\'s tech news',
      'analyze last quarter\'s sales trends',
    ])('"%s" -> research', (objective) => {
      expect(classifyObjective(objective)).toBe('research');
    });
  });

  describe('chat', () => {
    it.each(['hi', 'how are you doing today', 'thanks for the help', 'good morning'])('"%s" -> chat', (objective) => {
      expect(classifyObjective(objective)).toBe('chat');
    });
  });
});
