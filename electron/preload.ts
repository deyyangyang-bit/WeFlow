import { contextBridge, ipcRenderer } from 'electron'

type CloseConfirmPayload = {
  canMinimizeToTray: boolean
  restoreMethod?: 'tray' | 'dock'
}

// 暴露给渲染进程的 API
contextBridge.exposeInMainWorld('electronAPI', {
  // 配置
  config: {
    get: (key: string) => ipcRenderer.invoke('config:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('config:set', key, value),
    clear: () => ipcRenderer.invoke('config:clear')
  },

  // 通知
  notification: {
    show: (data: any) => ipcRenderer.invoke('notification:show', data),
    close: () => ipcRenderer.invoke('notification:close'),
    click: (payload: any) => ipcRenderer.send('notification-clicked', payload),
    ready: () => ipcRenderer.send('notification:ready'),
    resize: (width: number, height: number) => ipcRenderer.send('notification:resize', { width, height }),
    // 原生玻璃面板：卡片实测几何上报 / 退场淡出 / 亮度带回调（Windows 原生模式专用）
    glassRect: (payload: any) => ipcRenderer.send('notification:glassRect', payload),
    glassHide: () => ipcRenderer.send('notification:glassHide'),
    onLuma: (callback: (bands: any) => void) => {
      const listener = (_: any, bands: any) => callback(bands)
      ipcRenderer.on('notification:luma', listener)
      return () => ipcRenderer.removeListener('notification:luma', listener)
    },
    onShow: (callback: (event: any, data: any) => void) => {
      ipcRenderer.on('notification:show', callback)
      return () => ipcRenderer.removeAllListeners('notification:show')
    },
    // 监听原本发送出来的navigate-to-session事件，跳转到具体的会话
    onNavigateToSession: (callback: (sessionId: string) => void) => {
      const listener = (_: any, sessionId: string) => callback(sessionId)
      ipcRenderer.on('navigate-to-session', listener)
      return () => ipcRenderer.removeListener('navigate-to-session', listener)
    },
    onNavigateToRoute: (callback: (route: string) => void) => {
      const listener = (_: any, route: string) => callback(route)
      ipcRenderer.on('navigate-to-route', listener)
      return () => ipcRenderer.removeListener('navigate-to-route', listener)
    }
  },

  // 认证
  auth: {
    hello: (message?: string) => ipcRenderer.invoke('auth:hello', message),
    verifyEnabled: () => ipcRenderer.invoke('auth:verifyEnabled'),
    unlock: (password: string) => ipcRenderer.invoke('auth:unlock', password),
    enableLock: (password: string) => ipcRenderer.invoke('auth:enableLock', password),
    disableLock: (password: string) => ipcRenderer.invoke('auth:disableLock', password),
    changePassword: (oldPassword: string, newPassword: string) => ipcRenderer.invoke('auth:changePassword', oldPassword, newPassword),
    setHelloSecret: (password: string) => ipcRenderer.invoke('auth:setHelloSecret', password),
    clearHelloSecret: () => ipcRenderer.invoke('auth:clearHelloSecret'),
    isLockMode: () => ipcRenderer.invoke('auth:isLockMode')
  },

  // 本地身份档案（PRD §1.2a；角色仅署名用途，与应用锁完全独立）
  identity: {
    get: () => ipcRenderer.invoke('identity:get'),
    set: (payload: { name: string; role?: string }) => ipcRenderer.invoke('identity:set', payload),
    dismissOnboarding: () => ipcRenderer.invoke('identity:onboarding:dismiss')
  },

  // 内网同步（Phase 1 最小版）：状态查询 + 手动立即一轮
  lanSync: {
    status: () => ipcRenderer.invoke('lansync:status'),
    runNow: () => ipcRenderer.invoke('lansync:run')
  },


  // 对话框
  dialog: {
    openFile: (options: any) => ipcRenderer.invoke('dialog:openFile', options),
    openDirectory: (options: any) => ipcRenderer.invoke('dialog:openDirectory', options),
    saveFile: (options: any) => ipcRenderer.invoke('dialog:saveFile', options)
  },

  // Shell
  shell: {
    openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
    showItemInFolder: (path: string) => ipcRenderer.invoke('shell:showItemInFolder', path),
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url)
  },

  // App
  app: {
    getDownloadsPath: () => ipcRenderer.invoke('app:getDownloadsPath'),
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getLaunchAtStartupStatus: () => ipcRenderer.invoke('app:getLaunchAtStartupStatus'),
    setLaunchAtStartup: (enabled: boolean) => ipcRenderer.invoke('app:setLaunchAtStartup', enabled),
    checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
    downloadAndInstall: () => ipcRenderer.invoke('app:downloadAndInstall'),
    ignoreUpdate: (version: string) => ipcRenderer.invoke('app:ignoreUpdate', version),
    onDownloadProgress: (callback: (progress: any) => void) => {
      ipcRenderer.on('app:downloadProgress', (_, progress) => callback(progress))
      return () => ipcRenderer.removeAllListeners('app:downloadProgress')
    },
    onUpdateAvailable: (callback: (info: { version: string; releaseNotes: string }) => void) => {
      ipcRenderer.on('app:updateAvailable', (_, info) => callback(info))
      return () => ipcRenderer.removeAllListeners('app:updateAvailable')
    },
  },

  // 日志
  log: {
    getPath: () => ipcRenderer.invoke('log:getPath'),
    read: () => ipcRenderer.invoke('log:read'),
    clear: () => ipcRenderer.invoke('log:clear'),
    debug: (data: any) => ipcRenderer.send('log:debug', data)
  },

  diagnostics: {
    getExportCardLogs: (options?: { limit?: number }) =>
      ipcRenderer.invoke('diagnostics:getExportCardLogs', options),
    clearExportCardLogs: () =>
      ipcRenderer.invoke('diagnostics:clearExportCardLogs'),
    recordResourceStats: (payload: any) =>
      ipcRenderer.invoke('diagnostics:recordResourceStats', payload),
    getResourceStats: (options?: { limit?: number }) =>
      ipcRenderer.invoke('diagnostics:getResourceStats', options),
    clearResourceStats: () =>
      ipcRenderer.invoke('diagnostics:clearResourceStats'),
    exportExportCardLogs: (payload: { filePath: string; frontendLogs?: unknown[] }) =>
      ipcRenderer.invoke('diagnostics:exportExportCardLogs', payload)
  },

  // 窗口控制
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximizeStateChanged: (callback: (isMaximized: boolean) => void) => {
      const listener = (_: unknown, isMaximized: boolean) => callback(isMaximized)
      ipcRenderer.on('window:maximizeStateChanged', listener)
      return () => ipcRenderer.removeListener('window:maximizeStateChanged', listener)
    },
    close: () => ipcRenderer.send('window:close'),
    onCloseConfirmRequested: (callback: (payload: CloseConfirmPayload) => void) => {
      const listener = (_: unknown, payload: CloseConfirmPayload) => callback(payload)
      ipcRenderer.on('window:confirmCloseRequested', listener)
      return () => ipcRenderer.removeListener('window:confirmCloseRequested', listener)
    },
    respondCloseConfirm: (action: 'tray' | 'quit' | 'cancel') =>
      ipcRenderer.invoke('window:respondCloseConfirm', action),
    openAgreementWindow: () => ipcRenderer.invoke('window:openAgreementWindow'),
    completeOnboarding: () => ipcRenderer.invoke('window:completeOnboarding'),
    openOnboardingWindow: (options?: { mode?: 'add-account' }) => ipcRenderer.invoke('window:openOnboardingWindow', options),
    setTitleBarOverlay: (options: { symbolColor: string }) => ipcRenderer.send('window:setTitleBarOverlay', options),
    openVideoPlayerWindow: (videoPath: string, videoWidth?: number, videoHeight?: number) =>
      ipcRenderer.invoke('window:openVideoPlayerWindow', videoPath, videoWidth, videoHeight),
    resizeToFitVideo: (videoWidth: number, videoHeight: number) =>
      ipcRenderer.invoke('window:resizeToFitVideo', videoWidth, videoHeight),
    openImageViewerWindow: (imagePath: string, liveVideoPath?: string) =>
      ipcRenderer.invoke('window:openImageViewerWindow', imagePath, liveVideoPath),
    openChatHistoryWindow: (sessionId: string, messageId: number) =>
      ipcRenderer.invoke('window:openChatHistoryWindow', sessionId, messageId),
    openChatHistoryPayloadWindow: (payload: { sessionId: string; title?: string; recordList: any[] }) =>
      ipcRenderer.invoke('window:openChatHistoryPayloadWindow', payload),
    getChatHistoryPayload: (payloadId: string) =>
      ipcRenderer.invoke('window:getChatHistoryPayload', payloadId),
    openSessionChatWindow: (
      sessionId: string,
      options?: {
        source?: 'chat' | 'export'
        initialDisplayName?: string
        initialAvatarUrl?: string
        initialContactType?: 'friend' | 'group' | 'official' | 'former_friend' | 'blocked' | 'other'
      }
    ) =>
      ipcRenderer.invoke('window:openSessionChatWindow', sessionId, options)
  },

  // 数据库路径
  dbPath: {
    autoDetect: () => ipcRenderer.invoke('dbpath:autoDetect'),
    scanWxids: (rootPath: string) => ipcRenderer.invoke('dbpath:scanWxids', rootPath),
    scanWxidCandidates: (rootPath: string) => ipcRenderer.invoke('dbpath:scanWxidCandidates', rootPath),
    getDefault: () => ipcRenderer.invoke('dbpath:getDefault')
  },

  // WCDB 数据库
  wcdb: {
    testConnection: (dbPath: string, hexKey: string, wxid: string) =>
      ipcRenderer.invoke('wcdb:testConnection', dbPath, hexKey, wxid),
    open: (dbPath: string, hexKey: string, wxid: string) =>
      ipcRenderer.invoke('wcdb:open', dbPath, hexKey, wxid),
    close: () => ipcRenderer.invoke('wcdb:close'),

  },

  backup: {
    create: (payload: { outputPath: string; options?: { includeImages?: boolean; includeVideos?: boolean; includeFiles?: boolean } }) => ipcRenderer.invoke('backup:create', payload),
    inspect: (payload: { archivePath: string }) => ipcRenderer.invoke('backup:inspect', payload),
    restore: (payload: { archivePath: string }) => ipcRenderer.invoke('backup:restore', payload),
    onProgress: (callback: (progress: any) => void) => {
      const listener = (_: unknown, progress: any) => callback(progress)
      ipcRenderer.on('backup:progress', listener)
      return () => ipcRenderer.removeListener('backup:progress', listener)
    },
    // 自动备份（PRD 1.1 双保险定时备份）：手动立即备份 / 状态查询 / 恢复（本机或网络层）/ 恢复密钥导出导入
    autoRunNow: () => ipcRenderer.invoke('backup:auto:runNow'),
    autoStatus: () => ipcRenderer.invoke('backup:auto:status'),
    autoRestore: (payload?: { backupId?: string; source?: 'local' | 'network' }) => ipcRenderer.invoke('backup:auto:restore', payload),
    recoveryKeyExport: (payload: { passphrase: string; filePath?: string }) => ipcRenderer.invoke('backup:auto:recoveryKey:export', payload),
    /** adopt=true（仅新机首次恢复门禁开放时由 UI 显式确认）：采用恢复密钥并隔离本机旧密钥与旧备份 */
    recoveryKeyImport: (payload: { passphrase: string; filePath?: string; adopt?: boolean }) => ipcRenderer.invoke('backup:auto:recoveryKey:import', payload)
  },

  // 密钥获取
  key: {
    autoGetDbKey: () => ipcRenderer.invoke('key:autoGetDbKey'),
    autoGetImageKey: (manualDir?: string, wxid?: string) => ipcRenderer.invoke('key:autoGetImageKey', manualDir, wxid),
    scanImageKeyFromMemory: (userDir: string) => ipcRenderer.invoke('key:scanImageKeyFromMemory', userDir),
    onDbKeyStatus: (callback: (payload: { message: string; level: number }) => void) => {
      ipcRenderer.on('key:dbKeyStatus', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('key:dbKeyStatus')
    },
    onImageKeyStatus: (callback: (payload: { message: string }) => void) => {
      ipcRenderer.on('key:imageKeyStatus', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('key:imageKeyStatus')
    }
  },


  // 聊天
  chat: {
    connect: () => ipcRenderer.invoke('chat:connect'),
    getSessions: () => ipcRenderer.invoke('chat:getSessions'),
    markAllSessionsRead: () => ipcRenderer.invoke('chat:markAllSessionsRead'),
    getAntiRevokeSessions: () => ipcRenderer.invoke('chat:getAntiRevokeSessions'),
    getSessionStatuses: (usernames: string[]) => ipcRenderer.invoke('chat:getSessionStatuses', usernames),
    getExportTabCounts: () => ipcRenderer.invoke('chat:getExportTabCounts'),
    getContactTypeCounts: () => ipcRenderer.invoke('chat:getContactTypeCounts'),
    getSessionMessageCounts: (sessionIds: string[], options?: { preferHintCache?: boolean; bypassSessionCache?: boolean }) => ipcRenderer.invoke('chat:getSessionMessageCounts', sessionIds, options),
    enrichSessionsContactInfo: (
      usernames: string[],
      options?: { skipDisplayName?: boolean; onlyMissingAvatar?: boolean }
    ) => ipcRenderer.invoke('chat:enrichSessionsContactInfo', usernames, options),
    getMessages: (sessionId: string, offset?: number, limit?: number, startTime?: number, endTime?: number, ascending?: boolean) =>
      ipcRenderer.invoke('chat:getMessages', sessionId, offset, limit, startTime, endTime, ascending),
    getLatestMessages: (sessionId: string, limit?: number) =>
      ipcRenderer.invoke('chat:getLatestMessages', sessionId, limit),
    getNewMessages: (sessionId: string, minTime: number, limit?: number, cursor?: {
      createTime?: number
      sortSeq?: number
      localId?: number
      serverId?: number | string
      serverIdRaw?: string
    }) =>
      ipcRenderer.invoke('chat:getNewMessages', sessionId, minTime, limit, cursor),
    getContact: (username: string) => ipcRenderer.invoke('chat:getContact', username),
    getContactAvatar: (username: string, chatroomId?: string) => ipcRenderer.invoke('chat:getContactAvatar', username, chatroomId),
    updateMessage: (sessionId: string, localId: number, createTime: number, newContent: string) =>
      ipcRenderer.invoke('chat:updateMessage', sessionId, localId, createTime, newContent),
    deleteMessage: (sessionId: string, localId: number, createTime: number, dbPathHint?: string) =>
      ipcRenderer.invoke('chat:deleteMessage', sessionId, localId, createTime, dbPathHint),
    checkAntiRevokeTriggers: (sessionIds: string[]) =>
      ipcRenderer.invoke('chat:checkAntiRevokeTriggers', sessionIds),
    installAntiRevokeTriggers: (sessionIds: string[]) =>
      ipcRenderer.invoke('chat:installAntiRevokeTriggers', sessionIds),
    uninstallAntiRevokeTriggers: (sessionIds: string[]) =>
      ipcRenderer.invoke('chat:uninstallAntiRevokeTriggers', sessionIds),
    resolveTransferDisplayNames: (chatroomId: string, payerUsername: string, receiverUsername: string) =>
      ipcRenderer.invoke('chat:resolveTransferDisplayNames', chatroomId, payerUsername, receiverUsername),
    getMyAvatarUrl: () => ipcRenderer.invoke('chat:getMyAvatarUrl'),
    downloadEmoji: (cdnUrl: string, md5?: string) => ipcRenderer.invoke('chat:downloadEmoji', cdnUrl, md5),
    getCachedMessages: (sessionId: string) => ipcRenderer.invoke('chat:getCachedMessages', sessionId),
    clearCurrentAccountData: (options: { clearCache?: boolean; clearExports?: boolean }) =>
      ipcRenderer.invoke('chat:clearCurrentAccountData', options),
    // §2.40 微信号分库：当前账号业务数据归档（两库改名 .archived-<时间戳>.db 后重开新空库）
    archiveBusinessData: () => ipcRenderer.invoke('chat:archiveBusinessData'),
    close: () => ipcRenderer.invoke('chat:close'),
    getSessionDetail: (sessionId: string) => ipcRenderer.invoke('chat:getSessionDetail', sessionId),
    getSessionDetailFast: (sessionId: string) => ipcRenderer.invoke('chat:getSessionDetailFast', sessionId),
    getSessionDetailExtra: (sessionId: string) => ipcRenderer.invoke('chat:getSessionDetailExtra', sessionId),
    getExportSessionStats: (
      sessionIds: string[],
      options?: {
        includeRelations?: boolean
        forceRefresh?: boolean
        allowStaleCache?: boolean
        preferAccurateSpecialTypes?: boolean
        cacheOnly?: boolean
        beginTimestamp?: number
        endTimestamp?: number
      }
    ) => ipcRenderer.invoke('chat:getExportSessionStats', sessionIds, options),
    getGroupMyMessageCountHint: (chatroomId: string) =>
      ipcRenderer.invoke('chat:getGroupMyMessageCountHint', chatroomId),
    getImageData: (sessionId: string, msgId: string) => ipcRenderer.invoke('chat:getImageData', sessionId, msgId),
    getVoiceData: (sessionId: string, msgId: string, createTime?: number, serverId?: string | number) =>
      ipcRenderer.invoke('chat:getVoiceData', sessionId, msgId, createTime, serverId),
    getAllVoiceMessages: (sessionId: string) => ipcRenderer.invoke('chat:getAllVoiceMessages', sessionId),
    getAllImageMessages: (sessionId: string) => ipcRenderer.invoke('chat:getAllImageMessages', sessionId),
    getMessageDates: (sessionId: string) => ipcRenderer.invoke('chat:getMessageDates', sessionId),
    getMessageDateCounts: (sessionId: string) => ipcRenderer.invoke('chat:getMessageDateCounts', sessionId),
    getResourceMessages: (options?: {
      sessionId?: string
      types?: Array<'image' | 'video' | 'voice' | 'file'>
      beginTimestamp?: number
      endTimestamp?: number
      limit?: number
      offset?: number
    }) => ipcRenderer.invoke('chat:getResourceMessages', options),
    getMediaStream: (options?: {
      sessionId?: string
      mediaType?: 'image' | 'video' | 'all'
      beginTimestamp?: number
      endTimestamp?: number
      limit?: number
      offset?: number
    }) => ipcRenderer.invoke('chat:getMediaStream', options),
    resolveVoiceCache: (sessionId: string, msgId: string) => ipcRenderer.invoke('chat:resolveVoiceCache', sessionId, msgId),
    getVoiceTranscript: (sessionId: string, msgId: string, createTime?: number, serverId?: string | number) => ipcRenderer.invoke('chat:getVoiceTranscript', sessionId, msgId, createTime, serverId),
    onVoiceTranscriptPartial: (callback: (payload: { sessionId?: string; msgId: string; createTime?: number; text: string }) => void) => {
      const listener = (_: any, payload: { sessionId?: string; msgId: string; createTime?: number; text: string }) => callback(payload)
      ipcRenderer.on('chat:voiceTranscriptPartial', listener)
      return () => ipcRenderer.removeListener('chat:voiceTranscriptPartial', listener)
    },
    getContacts: (options?: { lite?: boolean }) => ipcRenderer.invoke('chat:getContacts', options),
    getMessage: (sessionId: string, localId: number) =>
      ipcRenderer.invoke('chat:getMessage', sessionId, localId),
    searchMessages: (keyword: string, sessionId?: string, limit?: number, offset?: number, beginTimestamp?: number, endTimestamp?: number) =>
      ipcRenderer.invoke('chat:searchMessages', keyword, sessionId, limit, offset, beginTimestamp, endTimestamp),
    getMyFootprintStats: (
      beginTimestamp: number,
      endTimestamp: number,
      options?: {
        myWxid?: string
        privateSessionIds?: string[]
        groupSessionIds?: string[]
        mentionLimit?: number
        privateLimit?: number
        mentionMode?: 'text_at_me' | string
      }
    ) => ipcRenderer.invoke('chat:getMyFootprintStats', beginTimestamp, endTimestamp, options),
    exportMyFootprint: (
      beginTimestamp: number,
      endTimestamp: number,
      format: 'csv' | 'json',
      filePath: string
    ) => ipcRenderer.invoke('chat:exportMyFootprint', beginTimestamp, endTimestamp, format, filePath),
    onWcdbChange: (callback: (event: any, data: { type: string; json: string }) => void) => {
      ipcRenderer.on('wcdb-change', callback)
      return () => ipcRenderer.removeListener('wcdb-change', callback)
    }
  },



  // 图片解密
  image: {
    decrypt: (payload: {
      sessionId?: string
      imageMd5?: string
      imageDatName?: string
      createTime?: number
      force?: boolean
      preferFilePath?: boolean
      hardlinkOnly?: boolean
      disableUpdateCheck?: boolean
      allowCacheIndex?: boolean
      allowFilesystemScan?: boolean
      suppressEvents?: boolean
    }) =>
      ipcRenderer.invoke('image:decrypt', payload),
    resolveCache: (payload: {
      sessionId?: string
      imageMd5?: string
      imageDatName?: string
      createTime?: number
      preferFilePath?: boolean
      hardlinkOnly?: boolean
      disableUpdateCheck?: boolean
      allowCacheIndex?: boolean
      allowCachePromotion?: boolean
      allowFilesystemScan?: boolean
      suppressEvents?: boolean
    }) =>
      ipcRenderer.invoke('image:resolveCache', payload),
    resolveCacheBatch: (
      payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number; preferFilePath?: boolean; hardlinkOnly?: boolean }>,
      options?: { disableUpdateCheck?: boolean; allowCacheIndex?: boolean; allowCachePromotion?: boolean; allowFilesystemScan?: boolean; preferFilePath?: boolean; hardlinkOnly?: boolean; suppressEvents?: boolean }
    ) => ipcRenderer.invoke('image:resolveCacheBatch', payloads, options),
    preload: (
      payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number }>,
      options?: { allowDecrypt?: boolean; allowCacheIndex?: boolean; allowFilesystemScan?: boolean; emitResolved?: boolean; scope?: string; priority?: 'high' | 'normal' | 'low' }
    ) => ipcRenderer.invoke('image:preload', payloads, options),
    cancelPreloadScope: (scope: string) =>
      ipcRenderer.invoke('image:cancelPreloadScope', scope),
    getPreloadStats: () =>
      ipcRenderer.invoke('image:getPreloadStats'),
    preloadHardlinkMd5s: (md5List: string[], options?: { chunkSize?: number; yieldMs?: number; filesystemFallback?: boolean }) =>
      ipcRenderer.invoke('image:preloadHardlinkMd5s', md5List, options),
    onUpdateAvailable: (callback: (payload: { cacheKey: string; sessionId?: string; createTime?: number; imageMd5?: string; imageDatName?: string }) => void) => {
      const listener = (_: unknown, payload: { cacheKey: string; sessionId?: string; createTime?: number; imageMd5?: string; imageDatName?: string }) => callback(payload)
      ipcRenderer.on('image:updateAvailable', listener)
      return () => ipcRenderer.removeListener('image:updateAvailable', listener)
    },
    onCacheResolved: (callback: (payload: { cacheKey: string; sessionId?: string; createTime?: number; imageMd5?: string; imageDatName?: string; localPath: string }) => void) => {
      const listener = (_: unknown, payload: { cacheKey: string; sessionId?: string; createTime?: number; imageMd5?: string; imageDatName?: string; localPath: string }) => callback(payload)
      ipcRenderer.on('image:cacheResolved', listener)
      return () => ipcRenderer.removeListener('image:cacheResolved', listener)
    },
    onDecryptProgress: (callback: (payload: {
      cacheKey: string
      imageMd5?: string
      imageDatName?: string
      stage: 'queued' | 'locating' | 'decrypting' | 'writing' | 'done' | 'failed'
      progress: number
      status: 'running' | 'done' | 'error'
      message?: string
    }) => void) => {
      const listener = (_: unknown, payload: {
        cacheKey: string
        imageMd5?: string
        imageDatName?: string
        stage: 'queued' | 'locating' | 'decrypting' | 'writing' | 'done' | 'failed'
        progress: number
        status: 'running' | 'done' | 'error'
        message?: string
      }) => callback(payload)
      ipcRenderer.on('image:decryptProgress', listener)
      return () => ipcRenderer.removeListener('image:decryptProgress', listener)
    },
    startAutoDownload: (whitelist: string[] | string) => ipcRenderer.invoke('image:startAutoDownload', whitelist),
    stopAutoDownload: () => ipcRenderer.invoke('image:stopAutoDownload'),
    getAutoDownloadStatus: () => ipcRenderer.invoke('image:getAutoDownloadStatus')
  },

  // 视频
  video: {
    getVideoInfo: (videoMd5: string, options?: { includePoster?: boolean; posterFormat?: 'dataUrl' | 'fileUrl' }) => ipcRenderer.invoke('video:getVideoInfo', videoMd5, options),
    getVideoInfoBatch: (videoMd5List: string[], options?: { includePoster?: boolean; posterFormat?: 'dataUrl' | 'fileUrl' }) =>
      ipcRenderer.invoke('video:getVideoInfoBatch', videoMd5List, options),
    parseVideoMd5: (content: string) => ipcRenderer.invoke('video:parseVideoMd5', content)
  },

  process: {
    platform: process.platform,
    arch: process.arch
  },

  // Hermes 只读智能体（设计-Hermes-MVP 智能体第一刀）：任务四接口 + 进度事件。
  // 零发送类通道：hermes 命名空间内没有任何 send 类 IPC，AI 碰不到发送键。
  hermes: {
    startTask: (payload: {
      goal: string
      context?: { kind: 'global' } | { kind: 'chat'; sessionId?: string } | { kind: 'customer'; accountId?: number; sessionId?: string }
      contextLabel?: string
    }) => ipcRenderer.invoke('hermes:task:start', payload),
    continueTask: (payload: { taskId: string; question: string }) =>
      ipcRenderer.invoke('hermes:task:continue', payload),
    cancelTask: (taskId: string) => ipcRenderer.invoke('hermes:task:cancel', taskId),
    getTask: (taskId: string) => ipcRenderer.invoke('hermes:task:get', taskId),
    // 进度事件：返回退订函数（只移除本次注册的 listener）
    onTaskProgress: (callback: (task: unknown) => void) => {
      const listener = (_: unknown, task: unknown) => callback(task)
      ipcRenderer.on('hermes:task:progress', listener as never)
      return () => ipcRenderer.removeListener('hermes:task:progress', listener as never)
    }
  },

  // 数据分析
  analytics: {
    getOverallStatistics: (force?: boolean) => ipcRenderer.invoke('analytics:getOverallStatistics', force),
    getContactRankings: (limit?: number, beginTimestamp?: number, endTimestamp?: number) =>
      ipcRenderer.invoke('analytics:getContactRankings', limit, beginTimestamp, endTimestamp),
    getTimeDistribution: () => ipcRenderer.invoke('analytics:getTimeDistribution'),
    getSelfSentDailyDistribution: (beginTimestamp?: number, endTimestamp?: number, force?: boolean) =>
      ipcRenderer.invoke('analytics:getSelfSentDailyDistribution', beginTimestamp, endTimestamp, force),
    getExcludedUsernames: () => ipcRenderer.invoke('analytics:getExcludedUsernames'),
    setExcludedUsernames: (usernames: string[]) => ipcRenderer.invoke('analytics:setExcludedUsernames', usernames),
    getExcludeCandidates: () => ipcRenderer.invoke('analytics:getExcludeCandidates'),
    onProgress: (callback: (payload: { status: string; progress: number }) => void) => {
      ipcRenderer.on('analytics:progress', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('analytics:progress')
    }
  },

  // 缓存管理
  cache: {
    clearAnalytics: () => ipcRenderer.invoke('cache:clearAnalytics'),
    clearImages: () => ipcRenderer.invoke('cache:clearImages'),
    clearAll: () => ipcRenderer.invoke('cache:clearAll')
  },

  // 群聊分析
  groupAnalytics: {
    getGroupChats: () => ipcRenderer.invoke('groupAnalytics:getGroupChats'),
    getGroupMembers: (chatroomId: string) => ipcRenderer.invoke('groupAnalytics:getGroupMembers', chatroomId),
    getGroupMembersPanelData: (
      chatroomId: string,
      options?: { forceRefresh?: boolean; includeMessageCounts?: boolean }
    ) => ipcRenderer.invoke('groupAnalytics:getGroupMembersPanelData', chatroomId, options),
    getGroupMessageRanking: (chatroomId: string, limit?: number, startTime?: number, endTime?: number) => ipcRenderer.invoke('groupAnalytics:getGroupMessageRanking', chatroomId, limit, startTime, endTime),
    getGroupActiveHours: (chatroomId: string, startTime?: number, endTime?: number) => ipcRenderer.invoke('groupAnalytics:getGroupActiveHours', chatroomId, startTime, endTime),
    getGroupMediaStats: (chatroomId: string, startTime?: number, endTime?: number) => ipcRenderer.invoke('groupAnalytics:getGroupMediaStats', chatroomId, startTime, endTime),
    getGroupMemberAnalytics: (chatroomId: string, memberUsername: string, startTime?: number, endTime?: number) => ipcRenderer.invoke('groupAnalytics:getGroupMemberAnalytics', chatroomId, memberUsername, startTime, endTime),
    getGroupMemberMessages: (
      chatroomId: string,
      memberUsername: string,
      options?: { startTime?: number; endTime?: number; limit?: number; cursor?: number }
    ) => ipcRenderer.invoke('groupAnalytics:getGroupMemberMessages', chatroomId, memberUsername, options),
    exportGroupMembers: (chatroomId: string, outputPath: string) => ipcRenderer.invoke('groupAnalytics:exportGroupMembers', chatroomId, outputPath),
    exportGroupMemberMessages: (chatroomId: string, memberUsername: string, outputPath: string, startTime?: number, endTime?: number) =>
      ipcRenderer.invoke('groupAnalytics:exportGroupMemberMessages', chatroomId, memberUsername, outputPath, startTime, endTime)
  },

  // 年度报告
  annualReport: {
    getAvailableYears: () => ipcRenderer.invoke('annualReport:getAvailableYears'),
    startAvailableYearsLoad: () => ipcRenderer.invoke('annualReport:startAvailableYearsLoad'),
    cancelAvailableYearsLoad: (taskId: string) => ipcRenderer.invoke('annualReport:cancelAvailableYearsLoad', taskId),
    generateReport: (year: number) => ipcRenderer.invoke('annualReport:generateReport', year),
    exportImages: (payload: { baseDir: string; folderName: string; images: Array<{ name: string; dataUrl: string }> }) =>
      ipcRenderer.invoke('annualReport:exportImages', payload),
    captureCurrentWindow: () => ipcRenderer.invoke('annualReport:captureCurrentWindow'),
    onAvailableYearsProgress: (callback: (payload: {
      taskId: string
      years?: number[]
      done: boolean
      error?: string
      canceled?: boolean
      strategy?: 'cache' | 'native' | 'hybrid'
      phase?: 'cache' | 'native' | 'scan' | 'done'
      statusText?: string
      nativeElapsedMs?: number
      scanElapsedMs?: number
      totalElapsedMs?: number
      switched?: boolean
      nativeTimedOut?: boolean
    }) => void) => {
      ipcRenderer.on('annualReport:availableYearsProgress', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('annualReport:availableYearsProgress')
    },
    onProgress: (callback: (payload: { status: string; progress: number }) => void) => {
      ipcRenderer.on('annualReport:progress', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('annualReport:progress')
    }
  },
  dualReport: {
    generateReport: (payload: { friendUsername: string; year: number }) =>
      ipcRenderer.invoke('dualReport:generateReport', payload),
    onProgress: (callback: (payload: { status: string; progress: number }) => void) => {
      ipcRenderer.on('dualReport:progress', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('dualReport:progress')
    }
  },

  // 导出
  export: {
    getExportStats: (sessionIds: string[], options: any) =>
      ipcRenderer.invoke('export:getExportStats', sessionIds, options),
    exportSessions: (sessionIds: string[], outputDir: string, options: any, controlOptions?: { taskId?: string }) =>
      ipcRenderer.invoke('export:exportSessions', sessionIds, outputDir, options, controlOptions),
    pauseTask: (taskId: string) =>
      ipcRenderer.invoke('export:pauseTask', taskId),
    resumeTask: (taskId: string) =>
      ipcRenderer.invoke('export:resumeTask', taskId),
    cancelTask: (taskId: string) =>
      ipcRenderer.invoke('export:cancelTask', taskId),
    exportSession: (sessionId: string, outputPath: string, options: any) =>
      ipcRenderer.invoke('export:exportSession', sessionId, outputPath, options),
    exportContacts: (outputDir: string, options: any) =>
      ipcRenderer.invoke('export:exportContacts', outputDir, options),
    onProgress: (callback: (payload: {
      current: number
      total: number
      currentSession: string
      currentSessionId?: string
      phase: string
      phaseProgress?: number
      phaseTotal?: number
      phaseLabel?: string
      collectedMessages?: number
      exportedMessages?: number
      estimatedTotalMessages?: number
      writtenFiles?: number
    }) => void) => {
      ipcRenderer.on('export:progress', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('export:progress')
    }
  },

  whisper: {
    downloadModel: () =>
      ipcRenderer.invoke('whisper:downloadModel'),
    getModelStatus: () =>
      ipcRenderer.invoke('whisper:getModelStatus'),
    onDownloadProgress: (callback: (payload: { modelName: string; downloadedBytes: number; totalBytes?: number; percent?: number }) => void) => {
      ipcRenderer.on('whisper:downloadProgress', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('whisper:downloadProgress')
    }
  },

  // 朋友圈
  sns: {
    getTimeline: (limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number) =>
      ipcRenderer.invoke('sns:getTimeline', limit, offset, usernames, keyword, startTime, endTime),
    getSnsUsernames: () => ipcRenderer.invoke('sns:getSnsUsernames'),
    getUserPostCounts: (options?: { preferCache?: boolean; forceRefresh?: boolean }) => ipcRenderer.invoke('sns:getUserPostCounts', options),
    getExportStatsFast: () => ipcRenderer.invoke('sns:getExportStatsFast'),
    getExportStats: (options?: { allowTimelineFallback?: boolean; preferCache?: boolean; forceRefresh?: boolean }) =>
      ipcRenderer.invoke('sns:getExportStats', options),
    getUserPostStats: (username: string) => ipcRenderer.invoke('sns:getUserPostStats', username),
    debugResource: (url: string) => ipcRenderer.invoke('sns:debugResource', url),
    proxyImage: (payload: { url: string; key?: string | number }) => ipcRenderer.invoke('sns:proxyImage', payload),
    downloadImage: (payload: { url: string; key?: string | number }) => ipcRenderer.invoke('sns:downloadImage', payload),
    exportTimeline: (options: any) => ipcRenderer.invoke('sns:exportTimeline', options),
    onExportProgress: (callback: (payload: any) => void) => {
      ipcRenderer.on('sns:exportProgress', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('sns:exportProgress')
    },
    selectExportDir: () => ipcRenderer.invoke('sns:selectExportDir'),
    installBlockDeleteTrigger: () => ipcRenderer.invoke('sns:installBlockDeleteTrigger'),
    uninstallBlockDeleteTrigger: () => ipcRenderer.invoke('sns:uninstallBlockDeleteTrigger'),
    checkBlockDeleteTrigger: () => ipcRenderer.invoke('sns:checkBlockDeleteTrigger'),
    deleteSnsPost: (postId: string) => ipcRenderer.invoke('sns:deleteSnsPost', postId),
    downloadEmoji: (params: { url: string; encryptUrl?: string; aesKey?: string }) => ipcRenderer.invoke('sns:downloadEmoji', params),
    getCacheMigrationStatus: () => ipcRenderer.invoke('sns:getCacheMigrationStatus'),
    startCacheMigration: () => ipcRenderer.invoke('sns:startCacheMigration'),
    onCacheMigrationProgress: (callback: (payload: any) => void) => {
      const listener = (_event: unknown, payload: any) => callback(payload)
      ipcRenderer.on('sns:cacheMigrationProgress', listener)
      return () => ipcRenderer.removeListener('sns:cacheMigrationProgress', listener)
    }
  },

  biz: {
    listAccounts: (account?: string) => ipcRenderer.invoke('biz:listAccounts', account),
    listAccountHealth: (account?: string) => ipcRenderer.invoke('biz:listAccountHealth', account),
    listMessages: (username: string, account?: string, limit?: number, offset?: number) =>
        ipcRenderer.invoke('biz:listMessages', username, account, limit, offset),
    listPayRecords: (account?: string, limit?: number, offset?: number) =>
        ipcRenderer.invoke('biz:listPayRecords', account, limit, offset)
  },



  // HTTP API 服务
  http: {
    start: (port?: number, host?: string) => ipcRenderer.invoke('http:start', port, host),
    stop: () => ipcRenderer.invoke('http:stop'),
    status: () => ipcRenderer.invoke('http:status')
  },

  // AI 见解
  insight: {
    testConnection: () => ipcRenderer.invoke('insight:testConnection'),
    getTodayStats: () => ipcRenderer.invoke('insight:getTodayStats'),
    listRecords: (filters?: any) => ipcRenderer.invoke('insight:listRecords', filters),
    getRecord: (id: string) => ipcRenderer.invoke('insight:getRecord', id),
    markRecordRead: (id: string) => ipcRenderer.invoke('insight:markRecordRead', id),
    clearRecords: (filters?: any) => ipcRenderer.invoke('insight:clearRecords', filters),
    triggerTest: () => ipcRenderer.invoke('insight:triggerTest'),
    triggerSessionInsight: (payload: {
      sessionId: string
      displayName?: string
      avatarUrl?: string
    }) => ipcRenderer.invoke('insight:triggerSessionInsight', payload),
    listProfileStatuses: (sessionIds: string[]) => ipcRenderer.invoke('insight:listProfileStatuses', sessionIds),
    generateProfile: (payload: {
      sessionId: string
      displayName?: string
      avatarUrl?: string
    }) => ipcRenderer.invoke('insight:generateProfile', payload),
    cancelProfile: (sessionId?: string) => ipcRenderer.invoke('insight:cancelProfile', sessionId),
    generateFootprintInsight: (payload: {
      rangeLabel: string
      summary: {
        private_inbound_people?: number
        private_replied_people?: number
        private_outbound_people?: number
        private_reply_rate?: number
        mention_count?: number
        mention_group_count?: number
      }
      privateSegments?: Array<{ displayName?: string; session_id?: string; incoming_count?: number; outgoing_count?: number; message_count?: number; replied?: boolean }>
      mentionGroups?: Array<{ displayName?: string; session_id?: string; count?: number }>
    }) => ipcRenderer.invoke('insight:generateFootprintInsight', payload),
    generateMessageInsight: (payload: {
      sessionId: string
      displayName?: string
      avatarUrl?: string
      targetLocalId?: number
      targetCreateTime?: number
      targetMessageKey?: string
      targetText: string
      targetSenderName?: string
      contextCount?: number
      forceRefresh?: boolean
    }) => ipcRenderer.invoke('insight:generateMessageInsight', payload)
  },

  groupSummary: {
    listRecords: (filters?: any) => ipcRenderer.invoke('groupSummary:listRecords', filters),
    getRecord: (id: string) => ipcRenderer.invoke('groupSummary:getRecord', id),
    triggerManual: (payload: {
      sessionId: string
      displayName?: string
      avatarUrl?: string
      startTime: number
      endTime: number
    }) => ipcRenderer.invoke('groupSummary:triggerManual', payload),
    triggerDay: (payload: {
      sessionId: string
      displayName?: string
      avatarUrl?: string
      date: string
    }) => ipcRenderer.invoke('groupSummary:triggerDay', payload)
  },

  // ─── 销售助手 ───────────────────────────────────────────────────────────────

  crm: {
    list: (entity: string, opts?: unknown) => ipcRenderer.invoke('crm:entity:list', entity, opts),
    get: (entity: string, id: number) => ipcRenderer.invoke('crm:entity:get', entity, id),
    create: (entity: string, payload: unknown) => ipcRenderer.invoke('crm:entity:create', entity, payload),
    update: (entity: string, id: number, patch: unknown) => ipcRenderer.invoke('crm:entity:update', entity, id, patch),
    formGet: (entity: string) => ipcRenderer.invoke('crm:form:get', entity),
    fieldMetaSave: (meta: unknown) => ipcRenderer.invoke('crm:fieldmeta:save', meta),
    reviewQueues: () => ipcRenderer.invoke('crm:review:queues'),
    workbench: () => ipcRenderer.invoke('crm:workbench'),
    statsOverview: () => ipcRenderer.invoke('crm:stats:overview'),
    statsAiAccuracy: (days?: number) => ipcRenderer.invoke('crm:stats:aiAccuracy', days),
    customers: () => ipcRenderer.invoke('crm:customers'),
    opportunityList: (opts?: unknown) => ipcRenderer.invoke('crm:opportunity:list', opts),
    opportunityGet: (id: number) => ipcRenderer.invoke('crm:opportunity:get', id),
    opportunityEvents: (id: number) => ipcRenderer.invoke('crm:opportunity:events', id),
    opportunityStats: () => ipcRenderer.invoke('crm:opportunity:stats'),
    opportunityStage: (id: number, stage: string) => ipcRenderer.invoke('crm:opportunity:stage', id, stage),
    opportunityClose: (id: number, status: 'lost', reason: string) => ipcRenderer.invoke('crm:opportunity:close', id, status, reason),
    opportunityRegisterDeal: (id: number, payload: unknown) => ipcRenderer.invoke('crm:opportunity:registerDeal', id, payload),
    opportunityIntentScore: (accountId: number) => ipcRenderer.invoke('crm:opportunity:intentScore', accountId),
    riskList: (opts?: unknown) => ipcRenderer.invoke('crm:risk:list', opts),
    riskResolve: (id: number) => ipcRenderer.invoke('crm:risk:resolve', id),
    enrichRun: (sessionId: string, displayName?: string) => ipcRenderer.invoke('crm:enrich:run', sessionId, displayName),
    manualSet: (accountId: number, field: string, value: string) => ipcRenderer.invoke('crm:enrich:manualSet', accountId, field, value),
    enrichBackfill: () => ipcRenderer.invoke('crm:enrich:backfill'),
    infoQueueApply: (accountId: number, field: string, action: 'accept' | 'reject') => ipcRenderer.invoke('crm:infoQueue:apply', accountId, field, action),
    accountsBySessions: (sessionIds: string[]) => ipcRenderer.invoke('crm:accounts:bySessions', sessionIds),
    customerProfile: (sessionId: string) => ipcRenderer.invoke('crm:customer:profile', sessionId),
    customerDeepAnalysis: (sessionId: string, displayName: string) => ipcRenderer.invoke('crm:customer:deepAnalysis', sessionId, displayName),
    allocationConfirm: (id: number, patch?: unknown) => ipcRenderer.invoke('crm:allocation:confirm', id, patch),
    allocationReject: (id: number) => ipcRenderer.invoke('crm:allocation:reject', id),
    paymentApprove: (id: number) => ipcRenderer.invoke('crm:payment:approve', id),
    paymentsByDay: (days?: number) => ipcRenderer.invoke('crm:payments:byDay', days),
    paymentClaim: (id: number, patch?: { account_id?: number; contract_id?: number; sales_name?: string }) => ipcRenderer.invoke('crm:payment:claim', id, patch),
    currentSalesName: () => ipcRenderer.invoke('crm:currentSalesName'),
    salesTeam: () => ipcRenderer.invoke('crm:sales:team'),
    salesTeamAdd: (name: string) => ipcRenderer.invoke('crm:sales:team:add', name),
    salesTeamRemove: (name: string) => ipcRenderer.invoke('crm:sales:team:remove', name),
    accountEnsure: (name: string) => ipcRenderer.invoke('crm:account:ensure', name),
    contractShip: (id: number) => ipcRenderer.invoke('crm:contract:ship', id),
    contractSign: (id: number) => ipcRenderer.invoke('crm:contract:sign', id),
    contractDelete: (id: number) => ipcRenderer.invoke('crm:contract:delete', id),
    customerDelete: (id: number) => ipcRenderer.invoke('crm:customer:delete', id),
    logisticsLink: (id: number, opts?: { accountId?: number; contractId?: number; ownerSales?: string }) => ipcRenderer.invoke('crm:logistics:link', id, opts),
    logisticsCandidates: (receiver: string, city: string) => ipcRenderer.invoke('crm:logistics:candidates', receiver, city),
    logisticsList: (opts?: { filter?: 'unlinked' | 'pending' | 'signed' }) => ipcRenderer.invoke('crm:logistics:list', opts),
    logisticsSigned: (id: number) => ipcRenderer.invoke('crm:logistics:signed', id),
    productImport: (rows: unknown[]) => ipcRenderer.invoke('crm:product:import', rows),
    contractEntryScope: () => ipcRenderer.invoke('crm:contract:entryScope'),
    contractByCreationRequest: (id: string, scope: unknown) => ipcRenderer.invoke('crm:contract:byCreationRequest', id, scope),
    contractBeginEntry: (input: unknown, scope: unknown) => ipcRenderer.invoke('crm:contract:beginEntry', input, scope),
    contractEntryQuotation: (data: unknown, scope: unknown) => ipcRenderer.invoke('crm:contract:entryQuotation', data, scope),
    quotationCreate: (data: unknown) => ipcRenderer.invoke('crm:quotation:create', data),
    quotationCurrent: (contractId: number) => ipcRenderer.invoke('crm:quotation:current', contractId),
    quotationHistory: (contractId: number) => ipcRenderer.invoke('crm:quotation:history', contractId),
    quotationAi: (sessionId: string, displayName: string) => ipcRenderer.invoke('crm:quotation:ai', sessionId, displayName),
    groupsList: () => ipcRenderer.invoke('crm:groups:list'),
    groupsSave: (g: unknown) => ipcRenderer.invoke('crm:groups:save', g),
    groupsUpdate: (id: number, patch: unknown) => ipcRenderer.invoke('crm:groups:update', id, patch),
    parseScanNow: () => ipcRenderer.invoke('crm:parse:scanNow'),
    docGenerate: (type: string, recordId: number, options?: unknown) => ipcRenderer.invoke('crm:doc:generate', type, recordId, options),
    aliasLearn: (alias: string, accountId: number) => ipcRenderer.invoke('crm:alias:learn', alias, accountId),
    aiDesc: (payload: unknown) => ipcRenderer.invoke('crm:product:aiDesc', payload),
    aiExtract: (template: string[], dataUrl: string) => ipcRenderer.invoke('crm:product:aiExtract', template, dataUrl),
    saveImage: (dataUrl: string, fileName: string) => ipcRenderer.invoke('crm:file:saveImage', dataUrl, fileName),
    readImage: (filePath: string) => ipcRenderer.invoke('crm:file:readImage', filePath),
    autoConfirmRun: () => ipcRenderer.invoke('crm:autoConfirm:run'),
    autoConfirmHistory: (limit?: number) => ipcRenderer.invoke('crm:autoConfirm:history', limit),
    autoConfirmUndo: (entity: string, id: number) => ipcRenderer.invoke('crm:autoConfirm:undo', entity, id),

    // 单机线索流转
    leadImport: (source: string, fileName: string, rows: unknown[]) => ipcRenderer.invoke('crm:lead:import', source, fileName, rows),
    leadList: (opts?: unknown) => ipcRenderer.invoke('crm:lead:list', opts),
    leadDetail: (id: number) => ipcRenderer.invoke('crm:lead:detail', id),
    leadOverview: () => ipcRenderer.invoke('crm:lead:overview'),
    leadStatus: (id: number, action: string, opts?: unknown) => ipcRenderer.invoke('crm:lead:status', id, action, opts),
    leadUpdate: (id: number, fields: { name?: string; wechat?: string }) => ipcRenderer.invoke('crm:lead:update', id, fields),
    leadToAccount: (id: number) => ipcRenderer.invoke('crm:lead:toAccount', id),
    leadScanSla: () => ipcRenderer.invoke('crm:lead:scanSla'),
    leadSlaComplete: (taskId: number) => ipcRenderer.invoke('crm:lead:slaComplete', taskId),
    leadSlaSkip: (taskId: number) => ipcRenderer.invoke('crm:lead:slaSkip', taskId),
    leadDeadReasons: () => ipcRenderer.invoke('crm:lead:deadReasons'),
    // 线索分配（Phase 1 完整版五端点，统一信封 { ok, data } / { ok:false, code, message }）
    assignmentAssign: (req: { leadIds: number[]; salesName: string; actor?: string }) => ipcRenderer.invoke('crm:assignment:assign', req),
    assignmentClaim: (req: { leadId: number; actor?: string }) => ipcRenderer.invoke('crm:assignment:claim', req),
    assignmentRecycle: (req: { assignmentId: number; reason?: string; actor?: string }) => ipcRenderer.invoke('crm:assignment:recycle', req),
    assignmentTransfer: (req: { assignmentId: number; toSales: string; reason?: string; actor?: string }) => ipcRenderer.invoke('crm:assignment:transfer', req),
    assignmentList: (opts?: { leadId?: number; salesName?: string; status?: string; page?: number; pageSize?: number }) => ipcRenderer.invoke('crm:assignment:list', opts),
    // 批量分配（设计稿屏 3）：按模式从待分配池取 N 条分给名单（weight/round_robin/load），批次审计可追溯
    assignmentAssignBatch: (req: { count: number; mode: 'weight' | 'round_robin' | 'load'; weights?: Record<string, number>; actor?: string }) => ipcRenderer.invoke('crm:assignment:assignBatch', req),
    // 加好友判定（PRD 1.4a 手动路）：绑定微信 → customer_identity + 停 SLA1 表 + lead→WX_ADDED + 审计
    identityBind: (req: { leadId: number; wxid: string; displayName?: string; actor?: string }) => ipcRenderer.invoke('crm:identity:bind', req),
    // 两段接力 SLA 第二段「聊了没有」（PRD 1.4）：扫描/人工结论写 assignment.sla2_scan_ref + 审计
    sla2Mark: (req: { leadId: number; verdict: string; confidence: number; scanRef: string; source?: string; note?: string; actor?: string }) => ipcRenderer.invoke('crm:sla2:mark', req),
    // 客户类型（PRD 1.5，dealer/end_user，'' 清除）：UPDATE customer + 审计
    customerSetType: (req: { customerId: number; type: string; actor?: string }) => ipcRenderer.invoke('crm:customer:setType', req),
    // 交付售后（2026-09-10）：交付登记 / 设备档案 / 以旧换新 / 复购等级后端单点写入，页面只读后端事实与任务
    deliveryRegister: (oppId: number, payload: { shipped_qty?: number; delivery_date?: number; over_ship_reason?: string; actor?: string }) => ipcRenderer.invoke('crm:delivery:register', oppId, payload),
    deliverySaveEquipment: (customerId: number, fields: Record<string, unknown>) => ipcRenderer.invoke('crm:delivery:saveEquipment', customerId, fields),
    deliveryProposeTradeIn: (customerId: number, basis: { kind: string; evidenceKey: string; reason: string; at?: number }) => ipcRenderer.invoke('crm:delivery:proposeTradeIn', customerId, basis),
    deliveryDecideTradeIn: (customerId: number, decision: 'accept' | 'reject') => ipcRenderer.invoke('crm:delivery:decideTradeIn', customerId, decision),
    deliveryScan: () => ipcRenderer.invoke('crm:delivery:scan'),
    deliveryTasks: () => ipcRenderer.invoke('crm:delivery:tasks'),
    deliverySuggestDate: (oppId: number) => ipcRenderer.invoke('crm:delivery:suggestDate', oppId),
    deliveryRecomputeRepeat: () => ipcRenderer.invoke('crm:delivery:recomputeRepeat'),
    // 认领满 24h AI 首次分类（PRD 2.4，B 档 proposed→人工裁决）：run=手动立即分析（不受 24h 限制）
    firstClassifyRun: (req: { leadId?: number; assignmentId?: number; actor?: string }) => ipcRenderer.invoke('crm:firstClassify:run', req),
    firstClassifyList: (opts?: { status?: string; leadId?: number; page?: number; pageSize?: number }) => ipcRenderer.invoke('crm:firstClassify:list', opts),
    firstClassifyConfirm: (req: { roundId: number; actor?: string }) => ipcRenderer.invoke('crm:firstClassify:confirm', req),
    firstClassifyReject: (req: { roundId: number; actor?: string; reason?: string }) => ipcRenderer.invoke('crm:firstClassify:reject', req),
    // 离职移交（PRD §1.9）：lead 批量调派循环（reason='离职'）+ owner 三列同步改写 + 流水/审计
    ownershipDeparture: (req: { fromSales: string; toSales: string; actor?: string }) => ipcRenderer.invoke('crm:ownership:departure', req),
    // 审计流水（宪法 §1.12 / API-CONTRACT §1.14，R 只读）：keyword 扩展一把搜 actor/detail/entity
    auditQuery: (opts?: { entityType?: string; entityId?: number; actor?: string; action?: string; keyword?: string; beginAt?: number; endAt?: number; page?: number; pageSize?: number }) => ipcRenderer.invoke('crm:audit:query', opts),
    // 归属留痕时间线（宪法 §1.8，R 只读，append-only）
    ownershipHistory: (opts: { entityType: string; entityId: number; page?: number; pageSize?: number }) => ipcRenderer.invoke('crm:ownership:history', opts),
    // 存量迁移报告（migration_report SSOT，R 只读）：每模块最新快照，与 audit_event 解耦
    migrationReports: () => ipcRenderer.invoke('crm:migration:report:list'),
    // 主管升级提醒（SLA1 三次超时通知闭环，2026-09-08）：列表（含未读数）+ 已读
    notifyList: (opts?: { status?: string; limit?: number; offset?: number }) => ipcRenderer.invoke('crm:notify:list', opts),
    notifyMarkRead: (ids: number[]) => ipcRenderer.invoke('crm:notify:markRead', { ids }),
    // SLA2「查看依据」（屏 5 右证据回查出口；主进程脱敏 + 字段裁剪，绝不返回 messageKey/wxid/绝对路径）
    sla2Evidence: (leadId: number) => ipcRenderer.invoke('crm:sla2:evidence', leadId),
    // 导入查重明细（2026-09-08 查重完善）：按批次取脱敏明细行，供结果展示与 CSV 导出
    importDedupeDetail: (batchId: number) => ipcRenderer.invoke('crm:import:dedupeDetail', batchId)
  },
  sales: {
    // 知识库（status 过滤后端 kbList 原生支持）
    kbList: (filters?: { category?: string; product_line?: string; scene?: string; status?: string }) =>
      ipcRenderer.invoke('sales:kb:list', filters),
    kbGet: (id: number) => ipcRenderer.invoke('sales:kb:get', id),
    kbCreate: (payload: { category: string; product_line?: string; title: string; content: string; tags?: string[]; scene?: string; ttl_date?: string | null }) =>
      ipcRenderer.invoke('sales:kb:create', payload),
    kbUpdate: (id: number, payload: { category?: string; product_line?: string; title?: string; content?: string; tags?: string[]; scene?: string; ttl_date?: string | null }) =>
      ipcRenderer.invoke('sales:kb:update', id, payload),
    kbRenewTtl: (id: number, ttlDate: string) => ipcRenderer.invoke('sales:kb:renewTtl', id, ttlDate),
    kbDelete: (id: number) => ipcRenderer.invoke('sales:kb:delete', id),
    kbSearch: (payload: { keyword: string; category?: string; product_line?: string }) =>
      ipcRenderer.invoke('sales:kb:search', payload),
    // 刀 1 知识审核（待审核区 发布/拒绝；拒绝必填拒因）
    kbReview: (id: number, action: 'publish' | 'reject', payload?: { reason?: string; official?: boolean }) =>
      ipcRenderer.invoke('sales:kb:review', id, action, payload),
    // 刀 2 采纳率只读聚合（复盘页）
    proposalStats: () => ipcRenderer.invoke('sales:proposal:stats'),
    // 刀 3 带引用知识问答（问知识库）：检索只读 published + LLM 组答案（temperature 0.2）
    kbAsk: (payload: { question: string }) => ipcRenderer.invoke('sales:kb:ask', payload),
    // 刀 3/5 问答 viewed 埋点（用户展开答案卡；同 askKey 只记一次；kind 区分 knowledge_ask/data_ask）
    kbAskViewed: (payload: { question?: string; askKey?: string; kind?: 'knowledge' | 'data' }) => ipcRenderer.invoke('sales:kb:askViewed', payload),
    // 刀 4 知识提案写入路（问答无命中/补充知识 → staging 行 source=proposal；evidence_key 硬门必填）
    kbPropose: (payload: { title: string; content: string; category?: string; scene?: string; tags?: string[]; evidence_key: string }) =>
      ipcRenderer.invoke('sales:kb:propose', payload),

    // 报表
    reportGenerate: (payload: { period_type: string; period_start: number; period_end: number }) =>
      ipcRenderer.invoke('sales:report:generate', payload),
    reportList: (limit?: number) => ipcRenderer.invoke('sales:report:list', limit),
    reportGet: (id: number) => ipcRenderer.invoke('sales:report:get', id),
    reportDelete: (id: number) => ipcRenderer.invoke('sales:report:delete', id),

    // 客户画像
    customerGet: (sessionId: string) => ipcRenderer.invoke('sales:customer:get', sessionId),
    // P0-3：客户当前视图（State+Judgment 组装，纯只读；UI 未消费）
    customerCurrentView: (sessionId: string) => ipcRenderer.invoke('sales:customer:currentView', sessionId),
    customerUpsert: (data: { session_id: string; display_name?: string; tags?: string; notes?: string }) =>
      // P0-2A.5：类型层撤销 stage 写权限（运行时还有 stripStageFromUpsert 兜底）
      ipcRenderer.invoke('sales:customer:upsert', data),
    customerList: (filters?: { stage?: string; search?: string; sortBy?: 'updated_at' | 'last_contact_at' | 'stage'; limit?: number }) =>
      ipcRenderer.invoke('sales:customer:list', filters),
    customerDetail: (sessionId: string) => ipcRenderer.invoke('sales:customer:detail', sessionId),
    dashboardStats: () => ipcRenderer.invoke('sales:dashboard:stats'),
    funnelStats: (days?: number) => ipcRenderer.invoke('sales:funnel:stats', days),
    // P0-4.2.2/4.3：Action Funnel（Task-level 六段聚合 + 下钻；纯只读）
    actionFunnelGet: (days?: number | null) => ipcRenderer.invoke('sales:actionFunnel:get', days),
    actionFunnelBreakdown: (days?: number | null) => ipcRenderer.invoke('sales:actionFunnel:breakdown', days),
    customerExport: () => ipcRenderer.invoke('sales:customer:export'),

    // 意向标签
    intentAnalyze: (sessionId: string) => ipcRenderer.invoke('sales:intent:analyze', sessionId),
    intentCorrect: (payload: { session_id: string; stage: string; reason?: string }) =>
      ipcRenderer.invoke('sales:intent:correct', payload),
    intentHistory: (sessionId: string, limit?: number) =>
      ipcRenderer.invoke('sales:intent:history', sessionId, limit),
    // 证据（P0-2B）：统一读入口，只读
    evidenceGetByKey: (payload: { session_id: string; message_key: string; evidence_text?: string }) =>
      ipcRenderer.invoke('sales:evidence:getByKey', payload),

    // 回复建议
    replySuggest: (payload: { session_id: string; context_messages: Array<{ role: string; content: string }> }) =>
      ipcRenderer.invoke('sales:reply:suggest', payload),

    // 待办
    todoList: (filters?: { status?: string; limit?: number }) =>
      ipcRenderer.invoke('sales:todo:list', filters),
    todoCreate: (payload: { session_id?: string; trigger_type: string; title: string; due_at?: number }) =>
      ipcRenderer.invoke('sales:todo:create', payload),
    todoUpdate: (id: number, updates: { status?: string; title?: string; due_at?: number }) =>
      ipcRenderer.invoke('sales:todo:update', id, updates),
    todoScan: (period?: string) => ipcRenderer.invoke('sales:todo:scan', period),
    profileBatch: (limit?: number, monthsBack?: number) => ipcRenderer.invoke('sales:profile:batch', limit, monthsBack),
    profileProgress: () => ipcRenderer.invoke('sales:profile:progress'),

    // 今日行动引擎
    actionGetToday: () => ipcRenderer.invoke('sales:action:getToday'),
    actionComplete: (taskId: number, action: 'done' | 'skipped') =>
      ipcRenderer.invoke('sales:action:complete', taskId, action),
    actionSuggest: (item: any) => ipcRenderer.invoke('sales:action:suggest', item),
    actionGetUnified: () => ipcRenderer.invoke('sales:action:getUnified'),
    actionRefresh: () => ipcRenderer.invoke('sales:action:refresh'),
    actionCompleteUnified: (sessionId: string, action: 'done' | 'skipped', taskId?: number) => ipcRenderer.invoke('sales:action:completeUnified', sessionId, action, taskId),
    // P0-3 E3.3：销售行动事件上报（script_copied/chat_opened；follow_up_done 由主进程状态转换触发）
    // P0-4.2.1：taskId 为 correlation key（卡片 sources[].rawTaskId），无任务上下文 NULL
    actionRecordEvent: (p: { sessionId: string; eventType: string; messageKey?: string | null; taskId?: number | null }) =>
      ipcRenderer.invoke('sales:action:recordEvent', p),

    // 周复盘
    reviewGenerate: () => ipcRenderer.invoke('sales:review:generate'),

    // 晨间摘要（设计-AI见解重定位 §3.1）
    morningDigestGenerate: () => ipcRenderer.invoke('sales:morningDigest:generate'),
    aiUsageGet: () => ipcRenderer.invoke('sales:aiUsage:get'),
    morningDigestGet: () => ipcRenderer.invoke('sales:morningDigest:get'),
    morningDigestRegenerate: () => ipcRenderer.invoke('sales:morningDigest:regenerate'),

    // 知识库批量导入
    kbImportCsv: (csvContent: string) => ipcRenderer.invoke('sales:kb:importCsv', csvContent),
    // 话术提炼
    kbExtractScripts: (sessionId: string, opts?: { beginDate?: string; endDate?: string }) =>
      ipcRenderer.invoke('sales:kb:extractScripts', sessionId, opts),
    kbScanCandidates: (options?: { minMessages?: number; maxDaysAgo?: number }) =>
      ipcRenderer.invoke('sales:kb:scanExtractCandidates', options),
    kbExtractScriptsAll: (contacts?: Array<{ sessionId: string; nickname: string }>, opts?: { beginDate?: string; endDate?: string }) =>
      ipcRenderer.invoke('sales:kb:extractScriptsAll', contacts, opts),
    // 批量提炼进度监听
    onExtractProgress: (cb: (data: { current: number; total: number; contactName: string; foundSoFar: number }) => void) => {
      const handler = (_: any, data: any) => cb(data)
      ipcRenderer.on('sales:kb:extractProgress', handler)
      return () => ipcRenderer.removeListener('sales:kb:extractProgress', handler)
    }
  },

  // D7 评测集标注（eval:*；写库端点主进程内已 enqueueSalesTask 串行化）
  eval: {
    candidatesGenerate: (opts?: { sample?: number; target?: number }) =>
      ipcRenderer.invoke('eval:candidates:generate', opts),
    list: () => ipcRenderer.invoke('eval:list'),
    label: (payload: { id: number; label: string; annotatedBy: string }) =>
      ipcRenderer.invoke('eval:label', payload),
    stats: () => ipcRenderer.invoke('eval:stats'),
    report: () => ipcRenderer.invoke('eval:report'),
    // 告警样本（alert_eval_case，宪法 §3；候选由 alert-eval.ts import 通道产出）
    alertList: () => ipcRenderer.invoke('eval:alert:list'),
    alertLabel: (payload: { id: number; label: string; annotatedBy: string }) =>
      ipcRenderer.invoke('eval:alert:label', payload),
    alertStats: () => ipcRenderer.invoke('eval:alert:stats')
  },

  social: {
    saveWeiboCookie: (rawInput: string) => ipcRenderer.invoke('social:saveWeiboCookie', rawInput),
    validateWeiboUid: (uid: string) => ipcRenderer.invoke('social:validateWeiboUid', uid)
  }
})
