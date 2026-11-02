import { describe, expect, it, vi } from 'vitest';
import { parseActionsFromStructuredOutput, postProcessInteractiveHtml } from '@openmaic/generation';

describe('action parser', () => {
  it('repairs malformed structured output and preserves interleaving', () => {
    const actions = parseActionsFromStructuredOutput(
      '[{"type":"text","content":"Start"},{"type":"action","name":"widget_setState","params":{}}',
      'interactive',
      ['widget_setState'],
    );
    expect(actions).toEqual([
      expect.objectContaining({ type: 'speech', text: 'Start' }),
      expect.objectContaining({ type: 'widget_setState', state: {} }),
    ]);
  });

  it('filters slide-only actions from non-slide scenes', () => {
    expect(
      parseActionsFromStructuredOutput(
        '[{"type":"action","name":"spotlight","params":{"elementId":"x"}}]',
        'quiz',
      ),
    ).toEqual([]);
  });

  it('drops action types the model invented and keeps the rest', () => {
    const warn = vi.fn();
    const actions = parseActionsFromStructuredOutput(
      '[{"type":"text","content":"Start"},' +
        '{"type":"action","name":"highlight_text","params":{}},' +
        '{"type":"action","name":"spotlight","params":{"elementId":"x","type":"zoom"}},' +
        '{"type":"text","content":"End"}]',
      'slide',
      undefined,
      { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    );
    expect(actions.map((action) => action.type)).toEqual(['speech', 'speech']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"highlight_text"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"zoom"'));
  });
});

describe('interactive HTML post-processing', () => {
  it('converts math, protects scripts, and injects KaTeX once', () => {
    const source =
      '<html><head></head><body>$x+1$<script>const price = "$5";</script></body></html>';
    const once = postProcessInteractiveHtml(source);
    const twice = postProcessInteractiveHtml(once);
    expect(once).toContain('\\(x+1\\)');
    expect(once).toContain('const price = "$5";');
    expect(once).toContain('katex.min.css');
    expect(twice.match(/katex\.min\.css/g) ?? []).toHaveLength(1);
  });
});
