/**
 * renderer-markdown.js — Markdown / rich-text formatting for chat messages.
 *
 * Supports fenced code blocks with lightweight syntax highlighting,
 * inline code, bold, lists, headings, and basic diff rendering.
 *
 * Depends on: renderer-utils.js (escapeHtml)
 */

/* ---------- Syntax keyword maps ---------- */
const SYNTAX_KEYWORDS = {
  js: /\b(const|let|var|function|return|if|else|for|while|switch|case|break|continue|class|new|this|import|export|from|default|async|await|try|catch|throw|typeof|instanceof|null|undefined|true|false|yield|of|in)\b/g,
  python: /\b(def|class|return|if|elif|else|for|while|import|from|as|try|except|raise|with|yield|lambda|pass|break|continue|True|False|None|self|and|or|not|in|is|async|await)\b/g,
  swift: /\b(func|class|struct|enum|protocol|let|var|return|if|else|guard|switch|case|for|while|import|self|Self|nil|true|false|throws|throw|try|catch|async|await|actor|public|private|internal|final|override|init|deinit|where|in|some|any)\b/g,
  html: /\b(html|head|body|div|span|p|a|img|script|style|link|meta|title|section|article|header|footer|nav|main|form|input|button|table|tr|td|th|ul|ol|li|h[1-6])\b/g,
  css: /\b(color|background|margin|padding|border|font|display|position|width|height|flex|grid|align|justify|transform|transition|opacity|overflow|z-index|cursor)\b/g,
  shell: /\b(echo|cd|ls|cat|grep|sed|awk|find|mkdir|rm|cp|mv|chmod|chown|export|source|if|then|else|fi|for|do|done|while|case|esac|function|return|exit|sudo|npm|node|git|swift|python)\b/g,
};

function detectLanguage(lang) {
  const l = (lang || '').trim().toLowerCase();
  if (['js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx', 'json'].includes(l)) return 'js';
  if (['py', 'python'].includes(l)) return 'python';
  if (['swift'].includes(l)) return 'swift';
  if (['html', 'xml', 'svg', 'jsx'].includes(l)) return 'html';
  if (['css', 'scss', 'sass', 'less'].includes(l)) return 'css';
  if (['sh', 'bash', 'zsh', 'shell', 'fish'].includes(l)) return 'shell';
  return null;
}

function highlightSyntax(code, lang) {
  let safe = escapeHtml(code);
  // String literals
  safe = safe.replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, '<span class="syn-str">$&</span>');
  // Comments (single-line)
  safe = safe.replace(/(\/\/.*$|#(?!!).*$)/gm, '<span class="syn-cmt">$&</span>');
  // Numbers
  safe = safe.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="syn-num">$1</span>');

  const langKey = detectLanguage(lang);
  if (langKey && SYNTAX_KEYWORDS[langKey]) {
    safe = safe.replace(SYNTAX_KEYWORDS[langKey], '<span class="syn-kw">$&</span>');
  }
  return safe;
}

/* ---------- Diff rendering ---------- */
function formatDiffBlock(code) {
  return escapeHtml(code).split('\n').map((line) => {
    if (line.startsWith('+')) return `<span class="diff-add">${line}</span>`;
    if (line.startsWith('-')) return `<span class="diff-del">${line}</span>`;
    if (line.startsWith('@')) return `<span class="diff-hunk">${line}</span>`;
    return line;
  }).join('\n');
}

/* ---------- Inline markdown ---------- */
function formatInlineMarkdown(line) {
  let safe = escapeHtml(line);
  safe = safe.replace(/`([^`]+)`/g, '<span class="inline-code">$1</span>');
  safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  safe = safe.replace(/_([^_]+)_/g, '<em>$1</em>');
  // Markdown links: [text](url)
  safe = safe.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="external-link" target="_blank" rel="noopener">$1</a>');
  // Bare URLs (http/https) — only if not already inside an href
  safe = safe.replace(/(^|[^"=])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" class="external-link" target="_blank" rel="noopener">$2</a>');
  return safe;
}

/* ---------- Main formatter ---------- */
function formatFriendlyText(text) {
  const input = String(text || '');
  const blocks = [];
  let paragraph = [];
  let listItems = [];
  let codeBlock = null; // { lang, lines }

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(`<p>${paragraph.map((line) => formatInlineMarkdown(line)).join('<br>')}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push(`<ul>${listItems.map((item) => `<li>${formatInlineMarkdown(item)}</li>`).join('')}</ul>`);
    listItems = [];
  };

  const lines = input.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Fenced code block start
    if (!codeBlock && /^```(\w*)/.test(trimmed)) {
      flushParagraph();
      flushList();
      const lang = trimmed.slice(3).trim();
      codeBlock = { lang, lines: [] };
      continue;
    }

    // Fenced code block end
    if (codeBlock && trimmed === '```') {
      const code = codeBlock.lines.join('\n');
      const langLabel = codeBlock.lang || 'code';
      const isDiff = codeBlock.lang === 'diff' || code.split('\n').some((l) => /^[+-@]/.test(l) && !/^---/.test(l) && !/^\+\+\+/.test(l));

      let rendered;
      if (isDiff) {
        rendered = formatDiffBlock(code);
      } else {
        rendered = highlightSyntax(code, codeBlock.lang);
      }

      blocks.push([
        `<div class="code-block" data-lang="${escapeHtml(langLabel)}">`,
        `<div class="code-block-head"><span class="code-lang">${escapeHtml(langLabel)}</span><button class="copy-code-btn" title="Copy">Copy</button></div>`,
        `<pre><code>${rendered}</code></pre>`,
        '</div>',
      ].join(''));

      codeBlock = null;
      continue;
    }

    // Inside code block
    if (codeBlock) {
      codeBlock.lines.push(line);
      continue;
    }

    // Normal markdown
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }
    // Horizontal rule
    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      flushParagraph();
      flushList();
      blocks.push('<hr>');
      continue;
    }
    if (/^#{1,3}\s+/.test(trimmed)) {
      flushParagraph();
      flushList();
      const level = trimmed.match(/^(#{1,3})/)[1].length;
      const heading = trimmed.replace(/^#{1,3}\s+/, '');
      blocks.push(`<h${level + 2}>${formatInlineMarkdown(heading)}</h${level + 2}>`);
      continue;
    }
    if (/^[-*•–]\s+/.test(trimmed)) {
      flushParagraph();
      listItems.push(trimmed.replace(/^[-*•–]\s+/, '').trim());
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      flushParagraph();
      listItems.push(trimmed.replace(/^\d+\.\s+/, '').trim());
      continue;
    }
    if (/^\*\*[^*]+\*\*$/.test(trimmed)) {
      flushParagraph();
      flushList();
      blocks.push(`<h3>${formatInlineMarkdown(trimmed.slice(2, -2))}</h3>`);
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }

  // Flush unclosed code block
  if (codeBlock) {
    const code = codeBlock.lines.join('\n');
    blocks.push(`<div class="code-block"><pre><code>${highlightSyntax(code, codeBlock.lang)}</code></pre></div>`);
  }

  flushParagraph();
  flushList();

  if (blocks.length === 0) {
    return '<p>No response yet.</p>';
  }
  return blocks.join('');
}
