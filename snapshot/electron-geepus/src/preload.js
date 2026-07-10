const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('geepus', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  clearKey: () => ipcRenderer.invoke('settings:clearKey'),
  listModels: () => ipcRenderer.invoke('models:list'),
  testConnector: (model) => ipcRenderer.invoke('connector:test', model),
  ask: (request) => ipcRenderer.invoke('assistant:ask', request),
  autoAssist: (request) => ipcRenderer.invoke('assistant:autoAssist', request),
  classifyIntent: (request) => ipcRenderer.invoke('assistant:classifyIntent', request),
  planAgentTask: (request) => ipcRenderer.invoke('agent:plan', request),
  executeAgentTask: (request) => ipcRenderer.invoke('agent:execute', request),
  runAgentObjective: (request) => ipcRenderer.invoke('agent:runObjective', request),
  resumeAgentObjective: (request) => ipcRenderer.invoke('agent:resumeObjective', request),
  stopAgentObjective: (request) => ipcRenderer.invoke('agent:stopObjective', request || {}),
  listAgentRuns: () => ipcRenderer.invoke('agent:listRuns'),
  listRecentArtifacts: (request) => ipcRenderer.invoke('agent:listArtifacts', request || {}),
  openWatchTask: (request) => ipcRenderer.invoke('watch:open', request || {}),
  getWatchSnapshot: (request) => ipcRenderer.invoke('watch:snapshot', request || {}),
  onWatchUpdate: (callback) => {
    const handler = (_event, payload) => {
      if (typeof callback === 'function') {
        callback(payload);
      }
    };
    ipcRenderer.on('watch:update', handler);
    return () => ipcRenderer.removeListener('watch:update', handler);
  },
  // Scheduler
  listScheduledTasks: () => ipcRenderer.invoke('scheduler:list'),
  addScheduledTask: (taskDef) => ipcRenderer.invoke('scheduler:add', taskDef),
  updateScheduledTask: (taskId, patch) => ipcRenderer.invoke('scheduler:update', taskId, patch),
  removeScheduledTask: (taskId) => ipcRenderer.invoke('scheduler:remove', taskId),
  runScheduledTaskNow: (taskId) => ipcRenderer.invoke('scheduler:runNow', taskId),

  // Triggers
  listTriggers: () => ipcRenderer.invoke('triggers:list'),
  addTrigger: (triggerDef) => ipcRenderer.invoke('triggers:add', triggerDef),
  updateTrigger: (triggerId, patch) => ipcRenderer.invoke('triggers:update', triggerId, patch),
  removeTrigger: (triggerId) => ipcRenderer.invoke('triggers:remove', triggerId),

    // Memory / RAG
    searchMemory: (query, options) => ipcRenderer.invoke('memory:search', query, options),
    getMemoryStats: () => ipcRenderer.invoke('memory:stats'),
    indexMemory: (text, namespace, metadata) => ipcRenderer.invoke('memory:index', text, namespace, metadata),
    clearMemory: (workspaceRoot) => ipcRenderer.invoke('memory:clear', workspaceRoot),

    // Pipelines / workflow engine
    listPipelines: () => ipcRenderer.invoke('pipelines:list'),
    getPipeline: (id) => ipcRenderer.invoke('pipelines:get', id),
    addPipeline: (data) => ipcRenderer.invoke('pipelines:add', data),
    updatePipeline: (id, patch) => ipcRenderer.invoke('pipelines:update', id, patch),
    removePipeline: (id) => ipcRenderer.invoke('pipelines:remove', id),
    runPipeline: (pipelineId) => ipcRenderer.invoke('pipelines:run', pipelineId),
    approvePipelineStep: (runId) => ipcRenderer.invoke('pipelines:approve', runId),
    rejectPipelineStep: (runId) => ipcRenderer.invoke('pipelines:reject', runId),
    cancelPipelineRun: (runId) => ipcRenderer.invoke('pipelines:cancel', runId),
    listPipelineRuns: () => ipcRenderer.invoke('pipelines:runs'),
    getPipelineRun: (runId) => ipcRenderer.invoke('pipelines:getRun', runId),

    // Web Research
    webSearch: (query, options) => ipcRenderer.invoke('web:search', query, options),
    webScrape: (url, options) => ipcRenderer.invoke('web:scrape', url, options),

    // Cost Tracking
    getCostToday: () => ipcRenderer.invoke('costs:today'),
    getCostSummary: (days) => ipcRenderer.invoke('costs:summary', days),
    getRunCost: (runId) => ipcRenderer.invoke('costs:run', runId),

    // Project Manager
    listProjects: () => ipcRenderer.invoke('projects:list'),
    addProject: (workspaceRoot, label) => ipcRenderer.invoke('projects:add', workspaceRoot, label),
    removeProject: (workspaceRoot) => ipcRenderer.invoke('projects:remove', workspaceRoot),
    updateProject: (workspaceRoot, patch) => ipcRenderer.invoke('projects:update', workspaceRoot, patch),
    setActiveProject: (workspaceRoot) => ipcRenderer.invoke('projects:setActive', workspaceRoot),
    getProjectDetail: (workspaceRoot) => ipcRenderer.invoke('projects:detail', workspaceRoot),

    // Integrations
    githubAction: (action, args) => ipcRenderer.invoke('integrations:github', action, args),
    sendWebhook: (message, webhookUrl) => ipcRenderer.invoke('integrations:webhook', message, webhookUrl),
    approvePush: (runId) => ipcRenderer.invoke('integrations:approvePush', runId),
    revokePush: (runId) => ipcRenderer.invoke('integrations:revokePush', runId),
    testWebhook: (webhookUrl) => ipcRenderer.invoke('integrations:testWebhook', webhookUrl),

    // Streaming ask — onChunk receives text deltas
    askStreaming: (request, onChunk) => {
      const handler = (_event, delta) => {
        if (typeof onChunk === 'function') onChunk(delta);
      };
      ipcRenderer.on('assistant:chunk', handler);
      return ipcRenderer.invoke('assistant:askStreaming', request).finally(() => {
        ipcRenderer.removeListener('assistant:chunk', handler);
      });
    },
    transcribeAudio: (request) => ipcRenderer.invoke('audio:transcribe', request || {}),
    audioRealtimeStart: (request) => ipcRenderer.invoke('audio:realtimeStart', request || {}),
    audioRealtimeAppend: (request) => ipcRenderer.invoke('audio:realtimeAppend', request || {}),
    audioRealtimeCommit: (request) => ipcRenderer.invoke('audio:realtimeCommit', request || {}),
    audioRealtimeStop: (request) => ipcRenderer.invoke('audio:realtimeStop', request || {}),
    onAudioRealtimeEvent: (callback) => {
      const handler = (_event, payload) => {
        if (typeof callback === 'function') callback(payload);
      };
      ipcRenderer.on('audio:realtimeEvent', handler);
      return () => ipcRenderer.removeListener('audio:realtimeEvent', handler);
    },

    // Ollama (Local Models)
    ollamaStatus: () => ipcRenderer.invoke('ollama:status'),

    // Knowledge & Security Viewers
    getKnowledgeData: () => ipcRenderer.invoke('knowledge:getData'),
    listBrowserControllers: (workspaceRoot) => ipcRenderer.invoke('browserControllers:list', workspaceRoot),
    promoteBrowserController: (workspaceRoot, specId) => ipcRenderer.invoke('browserControllers:promote', workspaceRoot, specId),
    getSecurityData: () => ipcRenderer.invoke('security:getData'),
    getLearningData: () => ipcRenderer.invoke('learning:getData'),
    saveLearningData: (patch) => ipcRenderer.invoke('learning:saveData', patch || {}),
    resetLearningData: (scope) => ipcRenderer.invoke('learning:reset', scope || 'skills'),
    ollamaStart: () => ipcRenderer.invoke('ollama:start'),
    ollamaPull: (modelId, onProgress) => {
      const handler = (_event, progress) => {
        if (typeof onProgress === 'function') onProgress(progress);
      };
      ipcRenderer.on('ollama:pullProgress', handler);
      return ipcRenderer.invoke('ollama:pull', modelId).finally(() => {
        ipcRenderer.removeListener('ollama:pullProgress', handler);
      });
    },
    ollamaDelete: (modelId) => ipcRenderer.invoke('ollama:delete', modelId),

  restartApp: () => ipcRenderer.invoke('app:restart'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  saveAttachment: (filename, dataBase64) => ipcRenderer.invoke('fs:saveAttachment', { filename, dataBase64 }),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
});
