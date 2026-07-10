/**
 * renderer-chat.js — Chat message rendering, streaming, and message actions.
 *
 * Features: message actions (copy, retry, edit, branch), collapsible tool
 * output, streaming token display, diff rendering for file writes.
 *
 * Depends on: renderer-state.js (state, el)
 *             renderer-utils.js (escapeHtml, formatRelativeTime)
 *             renderer-markdown.js (formatFriendlyText)
 *             renderer-threads.js (ensureCurrentThread, appendMessageToCurrentThread)
 */

function formatMessageBody(message) {
  if (message.technical) {
    return `<pre class="tech-block">${escapeHtml(message.content)}</pre>`;
  }
  return formatFriendlyText(message.content);
}

/* ---------- Tool output collapsible ---------- */
function renderToolOutput(message) {
  if (!message.toolCalls || message.toolCalls.length === 0) return '';
  return message.toolCalls.map((tc) => {
    const label = escapeHtml(tc.tool || 'Tool');
    const output = escapeHtml(tc.output || tc.result || '');
    return [
      '<details class="tool-output">',
      `<summary class="tool-output-summary">${label}</summary>`,
      `<pre class="tool-output-body">${output}</pre>`,
      '</details>',
    ].join('');
  }).join('');
}

/* ---------- Message actions ---------- */
function renderMessageActions(message, index) {
  const isAssistant = message.role === 'assistant';
  const isUser = message.role === 'user';
  if (!isAssistant && !isUser) return '';

  const actions = [];

  // Copy
  actions.push(`<button class="msg-action" data-action="copy" data-index="${index}" title="Copy to clipboard">Copy</button>`);

  if (isAssistant) {
    actions.push(`<button class="msg-action" data-action="retry" data-index="${index}" title="Retry this response">Retry</button>`);
  }

  if (isUser) {
    actions.push(`<button class="msg-action" data-action="edit" data-index="${index}" title="Edit and resend">Edit</button>`);
  }

  // Branch
  actions.push(`<button class="msg-action" data-action="branch" data-index="${index}" title="Branch conversation from here">Branch</button>`);

  return `<div class="msg-actions">${actions.join('')}</div>`;
}

/* ---------- Diff rendering for file write artifacts ---------- */
function renderFileDiff(message) {
  if (!message.diff) return '';
  return [
    '<details class="file-diff">',
    '<summary class="file-diff-summary">File Changes</summary>',
    `<div class="diff-view">${formatFriendlyText('```diff\n' + message.diff + '\n```')}</div>`,
    '</details>',
  ].join('');
}

/* ---------- Main thread renderer ---------- */
function renderCurrentThread() {
  const thread = ensureCurrentThread();
  if (!thread || !el.responseOutput) {
    return;
  }

  if (el.threadBudgetInput) {
    el.threadBudgetInput.value = Number.isFinite(Number(thread.budgetLimit)) ? Number(thread.budgetLimit).toFixed(2) : '1.00';
  }

  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  if (messages.length === 0 && !state.transientResponse) {
    el.responseOutput.innerHTML = [
      '<section class="empty-log">',
      '<p class="empty-log-eyebrow">Mission log is empty</p>',
      '<h3>Give Geepus an outcome, not a workflow.</h3>',
      '<p>Examples: “Audit this codebase and fix the top issues.” “Research the best option and recommend one.” “Use the browser to finish this task and report blockers.”</p>',
      '</section>',
    ].join('');
    if (typeof renderMissionControl === 'function') {
      renderMissionControl();
    }
    return;
  }

  const blocks = messages.map((message, index) => {
    const role = message.role === 'user' ? 'You' : (message.role === 'system' ? 'System' : 'Geepus');
    const cls = message.role === 'user' ? 'user' : (message.role === 'system' ? 'system' : 'assistant');
    return [
      `<article class="chat-msg ${cls}" data-msg-index="${index}">`,
      `<header class="chat-msg-head"><span>${escapeHtml(role)}</span><time>${escapeHtml(formatRelativeTime(message.ts))}</time></header>`,
      `<div class="chat-msg-body">${formatMessageBody(message)}</div>`,
      renderToolOutput(message),
      renderFileDiff(message),
      renderMessageActions(message, index),
      '</article>',
    ].join('');
  });

  if (state.transientResponse) {
    blocks.push([
      '<article class="chat-msg system pending">',
      '<header class="chat-msg-head"><span>Geepus</span><time>now</time></header>',
      `<div class="chat-msg-body">${state.transientResponse.technical
        ? `<pre class="tech-block">${escapeHtml(state.transientResponse.content)}</pre>`
        : formatFriendlyText(state.transientResponse.content)}</div>`,
      '</article>',
    ].join(''));
  }

  el.responseOutput.innerHTML = blocks.join('');
  el.responseOutput.scrollTop = el.responseOutput.scrollHeight;
  if (typeof renderMissionControl === 'function') {
    renderMissionControl();
  }

  // Bind copy-code buttons
  el.responseOutput.querySelectorAll('.copy-code-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const codeEl = btn.closest('.code-block')?.querySelector('code');
      if (codeEl) {
        navigator.clipboard.writeText(codeEl.textContent).then(() => {
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        });
      }
    });
  });

  // Bind message action buttons
  el.responseOutput.querySelectorAll('.msg-action').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const idx = parseInt(btn.dataset.index, 10);
      handleMessageAction(action, idx);
    });
  });
}

/* ---------- Message action handler ---------- */
function handleMessageAction(action, index) {
  const thread = ensureCurrentThread();
  if (!thread) return;
  const messages = thread.messages || [];
  const message = messages[index];
  if (!message) return;

  switch (action) {
    case 'copy':
      navigator.clipboard.writeText(message.content || '').then(() => {
        setStatus('Copied to clipboard.');
      });
      break;

    case 'retry': {
      // Find the last user message before this assistant message
      let userMsg = null;
      for (let i = index - 1; i >= 0; i--) {
        if (messages[i].role === 'user') { userMsg = messages[i]; break; }
      }
      if (userMsg && typeof sendChatMessage === 'function') {
        // Remove this assistant message and re-send
        thread.messages = messages.slice(0, index);
        sendChatMessage(userMsg.content);
      }
      break;
    }

    case 'edit': {
      // Put user message text back into prompt input
      if (el.promptInput && message.role === 'user') {
        el.promptInput.value = message.content || '';
        el.promptInput.focus();
        // Trim the thread to before this message
        thread.messages = messages.slice(0, index);
        renderCurrentThread();
        setStatus('Editing message. Press Send when ready.');
      }
      break;
    }

    case 'branch': {
      // Create a new thread branched from this point
      const branchMessages = messages.slice(0, index + 1);
      const branchThread = {
        id: `thread_${Date.now()}_branch`,
        label: `Branch from ${thread.label || 'thread'}`,
        messages: JSON.parse(JSON.stringify(branchMessages)),
        createdAt: new Date().toISOString(),
      };
      state.threads.push(branchThread);
      state.currentThreadId = branchThread.id;
      if (typeof saveThreadsToStorage === 'function') saveThreadsToStorage();
      if (typeof renderThreads === 'function') renderThreads();
      renderCurrentThread();
      setStatus('Branched conversation.');
      break;
    }
  }
}

/* ---------- Streaming support ---------- */
function appendStreamChunk(delta) {
  if (!state.transientResponse) {
    state.transientResponse = { content: '', technical: false };
  }
  state.transientResponse.content += delta;

  // Strip <think>...</think> blocks from display during streaming
  let displayContent = state.transientResponse.content;
  // Remove complete <think>...</think> blocks
  displayContent = displayContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Hide content inside an unclosed <think> block (still streaming)
  const openThink = displayContent.lastIndexOf('<think>');
  if (openThink >= 0 && displayContent.indexOf('</think>', openThink) < 0) {
    displayContent = displayContent.slice(0, openThink).trim();
  }

  // Incremental DOM update instead of full re-render
  const pending = el.responseOutput?.querySelector('.chat-msg.pending .chat-msg-body');
  if (pending) {
    pending.innerHTML = formatFriendlyText(displayContent || 'Thinking...');
    el.responseOutput.scrollTop = el.responseOutput.scrollHeight;
  } else {
    renderCurrentThread();
  }
}

function setResponse(content, { technical = false, persist = true } = {}) {
  if (!persist) {
    state.transientResponse = {
      content: String(content || ''),
      technical,
    };
    renderCurrentThread();
    if (typeof maybeSpeakAssistantResponse === 'function') {
      maybeSpeakAssistantResponse(content, { technical });
    }
    return;
  }
  state.transientResponse = null;
  appendMessageToCurrentThread('assistant', content, { technical });
  if (typeof maybeSpeakAssistantResponse === 'function') {
    maybeSpeakAssistantResponse(content, { technical });
  }
}
