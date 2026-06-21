/**
 * OpenZhangXueFeng — Frontend Application v2
 *
 * Features:
 *   - Sidebar with conversation list (switch, create, delete)
 *   - Streaming text chat (WebSocket)
 *   - Voice mode: text input → LLM streaming → TTS audio output
 *   - Voice call: Fish Audio ASR → LLM → TTS, with chat history
 *   - Audio playback via Web Audio API (PCM 16-bit 44100Hz)
 */

// ═══════════════════════════════════════════════════════════
// DOM Elements
// ═══════════════════════════════════════════════════════════
const chatArea          = document.getElementById('chatArea');
const chatEmpty         = document.getElementById('chatEmpty');
const conversationList  = document.getElementById('conversationList');
const messageInput      = document.getElementById('messageInput');
const btnSend           = document.getElementById('btnSend');
const btnStop           = document.getElementById('btnStop');
const btnVoiceToggle    = document.getElementById('btnVoiceToggle');
const btnCall           = document.getElementById('btnCall');
const btnCallEnd        = document.getElementById('btnCallEnd');
const btnCallMic        = document.getElementById('btnCallMic');
const btnNewChat        = document.getElementById('btnNewChat');
const btnMenu           = document.getElementById('btnMenu');
const sidebar           = document.getElementById('sidebar');
const callOverlay       = document.getElementById('callOverlay');
const callStatus        = document.getElementById('callStatus');
const callTimerEl       = document.getElementById('callTimer');
const callWaveform      = document.getElementById('callWaveform');
const callAvatar        = document.getElementById('callAvatar');
const callUserText      = document.getElementById('callUserText');
const callAssistantText = document.getElementById('callAssistantText');
const typingIndicator   = document.getElementById('typingIndicator');
const audioIndicator    = document.getElementById('audioIndicator');
const statusBadge       = document.getElementById('statusBadge');
const statusText        = statusBadge.querySelector('.status-text');
const modeLabel         = document.getElementById('modeLabel');

// ═══════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════
let voiceMode        = false;    // Voice output mode (text + TTS)
let isCallActive     = false;    // Voice call overlay
let isRecording      = false;    // Currently recording audio
let isProcessing     = false;    // Waiting for LLM/TTS
let stopRequested    = false;    // User clicked stop
let activeConvId     = null;     // Current conversation ID
let conversations    = [];       // Conversation list cache
let audioContext     = null;
let audioQueueItems  = [];
let isAudioPlaying   = false;
let activeAudioSrc   = null;  // currently playing source, for interruption
let streamMessageEl  = null;
let callTimer        = null;
let callStartTime    = null;

// ═══════════════════════════════════════════════════════════
// WebSocket
// ═══════════════════════════════════════════════════════════
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
let ws = null;
let reconnectAttempts = 0;

function connectWS() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        console.log('WS connected');
        reconnectAttempts = 0;
        setStatus('online', '在线');
        // Auto-create or load first conversation
        refreshConversations();
    };

    ws.onmessage = (event) => {
        try {
            handleMessage(JSON.parse(event.data));
        } catch (e) {
            console.error('Parse error:', e);
        }
    };

    ws.onclose = () => {
        setStatus('offline', '重连中...');
        setTimeout(connectWS, Math.min(1000 * 2**reconnectAttempts, 10000));
        reconnectAttempts++;
    };

    ws.onerror = (e) => console.error('WS error:', e);
}

function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ═══════════════════════════════════════════════════════════
// Message Handler
// ═══════════════════════════════════════════════════════════
function handleMessage(msg) {
    switch (msg.type) {
        case 'history':
            // Full conversation load
            activeConvId = msg.conv_id || null;
            renderHistory(msg.messages);
            break;

        case 'conv_active':
            // Just-set active conversation ID — don't clear chat
            activeConvId = msg.conv_id;
            // Refresh sidebar to show new conversation
            refreshConversations();
            break;

        case 'conv_list':
            conversations = msg.conversations;
            renderConversationList();
            break;

        case 'text_chunk':
            // Streaming text token
            hideTyping();
            appendStreamingChunk(msg.content);
            // Update call overlay during voice calls
            if (isCallActive) {
                callAssistantText.style.opacity = '1';
                callAssistantText.textContent =
                    (callAssistantText.textContent || '') + msg.content;
            }
            break;

        case 'text':
            // Complete text sentence (voice mode)
            hideTyping();
            finalizeStreaming();
            appendAssistantBubble(msg.content);
            // Show assistant response in call overlay during voice calls
            if (isCallActive) {
                callAssistantText.style.opacity = '1';
                callAssistantText.textContent =
                    (callAssistantText.textContent || '') + msg.content;
            }
            break;

        case 'audio':
            // Base64 PCM audio chunk
            enqueueAudio(msg.data);
            break;

        case 'status':
            handleStatus(msg.status);
            break;

        case 'citations':
            // full = all session citations (badge URL lookups)
            // data = per-message filtered (cite-list display)
            window._lastCitations = msg.full || msg.data;
            window._lastDisplayCites = msg.data;
            injectCiteData(window._lastCitations);
            // For voice mode: add citation list to last assistant bubble if missing
            if (msg.data && msg.data.length) {
                const msgs = chatArea.querySelectorAll('.message.assistant');
                if (msgs.length > 0) {
                    const lastBubble = msgs[msgs.length - 1].querySelector('.msg-bubble');
                    if (lastBubble && !lastBubble.querySelector('.cite-list')) {
                        lastBubble.innerHTML += buildCitationList(msg.data);
                    }
                }
            }
            break;

        case 'error':
            console.error('Server:', msg.message);
            addErrorBubble(msg.message);
            break;
    }
}

function handleStatus(s) {
    statusBadge.className = 'status-badge';
    switch (s) {
        case 'thinking':  setStatus('thinking', '思考中...'); break;
        case 'searching': setStatus('searching', '查数据...'); break;
        case 'speaking':  setStatus('speaking', '说话中...'); break;
        case 'done':
            setStatus('online', '在线');
            finalizeStreaming();
            isProcessing = false;
            updateUI();
            break;
    }
}

function setStatus(cls, text) {
    statusBadge.className = 'status-badge ' + cls;
    statusText.textContent = text;
}

// ═══════════════════════════════════════════════════════════
// Conversation Management
// ═══════════════════════════════════════════════════════════
async function refreshConversations() {
    try {
        const r = await fetch('/api/conversations');
        conversations = await r.json();
        renderConversationList();

        // Only auto-load if we have an active conversation ID already set
        // (e.g., from conv_active). Don't auto-load on initial page load —
        // let the user see the welcome screen and click a conversation.
    } catch (e) {
        console.error('Failed to load conversations:', e);
    }
}

function renderConversationList() {
    conversationList.innerHTML = '';

    if (conversations.length === 0) {
        conversationList.innerHTML =
            '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">暂无对话</div>';
        return;
    }

    conversations.forEach(conv => {
        const el = document.createElement('div');
        el.className = 'conv-item' + (conv.id === activeConvId ? ' active' : '');
        el.innerHTML = `
            <div class="conv-item-content">
                <div class="conv-item-title">${escapeHtml(conv.title || '新对话')}</div>
                <div class="conv-item-time">${formatTime(conv.updated_at)}</div>
            </div>
            <button class="conv-item-delete" data-id="${conv.id}" title="删除">×</button>
        `;

        el.addEventListener('click', (e) => {
            if (e.target.closest('.conv-item-delete')) return;
            loadConversation(conv.id);
        });

        el.querySelector('.conv-item-delete').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteConversation(conv.id);
        });

        conversationList.appendChild(el);
    });
}

function loadConversation(convId) {
    activeConvId = convId;
    send({ type: 'load_conv', conv_id: convId });
    renderConversationList();
    // Let renderHistory decide whether to show chatEmpty
}

function newConversation() {
    activeConvId = null;
    finalizeStreaming();
    chatArea.innerHTML = '';
    chatEmpty.classList.remove('hidden');
    send({ type: 'new_conv' });
    // Sidebar will update when conv_list arrives from server
}

async function deleteConversation(convId) {
    // If deleting the active conversation, clear UI immediately
    if (convId === activeConvId) {
        activeConvId = null;
        finalizeStreaming();
        chatArea.innerHTML = '';
        chatEmpty.classList.remove('hidden');
    }

    // Delete via REST
    try {
        await fetch(`/api/conversations/${convId}`, { method: 'DELETE' });
    } catch (e) {
        console.error('Delete REST failed:', e);
    }

    // Tell server to sync state (deletes file, updates index, sends conv_list)
    send({ type: 'delete_conv', conv_id: convId });
}

// ═══════════════════════════════════════════════════════════
// Chat Rendering
// ═══════════════════════════════════════════════════════════
function renderHistory(messages) {
    chatArea.innerHTML = '';
    if (!messages || messages.length === 0) {
        chatEmpty.classList.remove('hidden');
        return;
    }
    chatEmpty.classList.add('hidden');
    messages.forEach(m => {
        if (m.role === 'user') {
            addUserBubble(m.content);
        } else {
            // citations = full list (badge URL lookups)
            // display_citations = per-message filtered (cite-list display)
            window._lastCitations = m.citations || null;
            window._lastDisplayCites = m.display_citations || m.citations || null;
            addAssistantBubble(m.content);
        }
    });
    scrollToBottom();
}

function addUserBubble(text) {
    const div = document.createElement('div');
    div.className = 'message user';
    div.innerHTML = `<div class="msg-avatar">你</div><div class="msg-bubble">${escapeHtml(text)}</div>`;
    chatArea.appendChild(div);
    chatEmpty.classList.add('hidden');
    scrollToBottom();
}

function addAssistantBubble(text) {
    const div = document.createElement('div');
    div.className = 'message assistant';
    const displayCites = window._lastDisplayCites || window._lastCitations;
    const citesHtml = buildCitationList(displayCites);
    div.innerHTML = `<div class="msg-avatar">峰</div><div class="msg-bubble">${formatMsg(text, window._lastCitations)}${citesHtml}</div>`;
    chatArea.appendChild(div);
    chatEmpty.classList.add('hidden');
    // Also inject into badges created by previous messages (voice mode backfill)
    injectCiteData(window._lastCitations);
    scrollToBottom();
}

function appendStreamingChunk(chunk) {
    chatEmpty.classList.add('hidden');

    if (!streamMessageEl) {
        streamMessageEl = document.createElement('div');
        streamMessageEl.className = 'message assistant';
        streamMessageEl.innerHTML =
            `<div class="msg-avatar">峰</div>
             <div class="msg-bubble"><span class="streaming-content"></span><span class="streaming-cursor"></span></div>`;
        chatArea.appendChild(streamMessageEl);
    }
    streamMessageEl.querySelector('.streaming-content').textContent += chunk;
    scrollToBottom();
}

function appendAssistantBubble(text) {
    chatEmpty.classList.add('hidden');
    const div = document.createElement('div');
    div.className = 'message assistant';
    div.innerHTML = `<div class="msg-avatar">峰</div><div class="msg-bubble">${formatMsg(text, window._lastCitations)}</div>`;
    chatArea.appendChild(div);
    scrollToBottom();
}

function finalizeStreaming() {
    if (!streamMessageEl) return;
    const cursor = streamMessageEl.querySelector('.streaming-cursor');
    if (cursor) cursor.remove();
    const content = streamMessageEl.querySelector('.streaming-content');
    if (content) {
        const displayCites = window._lastDisplayCites || window._lastCitations;
        const citesHtml = buildCitationList(displayCites);
        streamMessageEl.querySelector('.msg-bubble').innerHTML =
            formatMsg(content.textContent, window._lastCitations) + citesHtml;
        // Inject citation URLs into newly created badges
        injectCiteData(window._lastCitations);
    }
    streamMessageEl = null;
}

function injectCiteData(cites) {
    if (!cites || !cites.length) return;
    const badges = chatArea.querySelectorAll('.cite-badge');
    badges.forEach(b => {
        if (b.dataset.url) return; // already injected
        const n = parseInt(b.dataset.cite, 10);
        const c = cites[n - 1];
        if (c && c.url) {
            b.dataset.url = c.url;
            b.dataset.title = c.title;
            b.dataset.snippet = c.snippet || '';
            b.title = c.title + '\n' + c.url;
        }
    });
}

function addErrorBubble(msg) {
    const div = document.createElement('div');
    div.className = 'message assistant';
    div.innerHTML = `<div class="msg-avatar" style="background:#ef4444;">!</div>
        <div class="msg-bubble" style="border-color:rgba(239,68,68,.3);color:#fca5a5;">⚠ ${escapeHtml(msg)}</div>`;
    chatArea.appendChild(div);
    isProcessing = false;
    updateUI();
}

function formatMsg(text, cites) {
    // Split into lines first for block-level processing
    const lines = text.split('\n');
    let html = '';
    let inUl = false, inOl = false;

    for (let i = 0; i < lines.length; i++) {
        let line = escapeHtml(lines[i]);

        // --- Horizontal rules
        if (/^[-*_]{3,}\s*$/.test(lines[i])) {
            html += '<hr>';
            inUl = inOl = false;
            continue;
        }

        // > Blockquote
        if (/^&gt;/.test(line)) {
            line = line.replace(/^&gt;\s?/, '');
            html += `<blockquote>${_inlineMd(line, cites)}</blockquote>`;
            continue;
        }

        // ### Headings
        const hMatch = lines[i].match(/^(#{1,6})\s+(.+)/);
        if (hMatch) {
            const level = Math.min(hMatch[1].length, 6);
            html += `<h${level}>${_inlineMd(escapeHtml(hMatch[2]), cites)}</h${level}>`;
            continue;
        }

        // - or * unordered list
        const ulMatch = lines[i].match(/^[-*]\s+(.+)/);
        if (ulMatch) {
            if (!inUl) { html += '<ul>'; inUl = true; }
            html += `<li>${_inlineMd(escapeHtml(ulMatch[1]), cites)}</li>`;
            continue;
        } else if (inUl) { html += '</ul>'; inUl = false; }

        // 1. ordered list
        const olMatch = lines[i].match(/^(\d+)\.\s+(.+)/);
        if (olMatch) {
            if (!inOl) { html += '<ol>'; inOl = true; }
            html += `<li>${_inlineMd(escapeHtml(olMatch[2]), cites)}</li>`;
            continue;
        } else if (inOl) { html += '</ol>'; inOl = false; }

        // Regular paragraph — just join with line breaks, no <p> wrap
        html += _inlineMd(line, cites) + '<br>';
    }

    if (inUl) html += '</ul>';
    if (inOl) html += '</ol>';

    return html;
}

// Inline markdown: bold, italic, code, strikethrough, citations, links
function _inlineMd(text, cites) {
    // Images: ![alt](url)
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="md-img" loading="lazy">');
    // Links: [text](url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="md-link">$1</a>');
    // Bold
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Strikethrough
    text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
    // Inline code
    text = text.replace(/`(.+?)`/g, '<code>$1</code>');
    // Citation markers
    text = text.replace(/\[(\d+(?:[,\-\s]\d+)*)\]/g, (_m, nums) => {
        const ids = nums.split(/[,\-\s]+/).filter(Boolean);
        return ids.map(n => {
            const idx = parseInt(n, 10) - 1;
            const c = (cites && cites[idx] && cites[idx].url) ? cites[idx] : null;
            const attrs = c
                ? ` data-url="${escapeAttr(c.url)}" data-title="${escapeAttr(c.title)}" data-snippet="${escapeAttr(c.snippet || '')}" title="${escapeAttr(c.title + '\n' + c.url)}"`
                : '';
            return `<sup class="cite-badge" data-cite="${n}"${attrs}>[${n}]</sup>`;
        }).join('');
    });
    return text;
}

function escapeAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildCitationList(citations) {
    if (!citations || citations.length === 0) return '';
    let html = '<div class=\"cite-list\">';
    citations.forEach((c, i) => {
        if (!c) return; // skip uncited entries
        const domain = (() => {
            try { return new URL(c.url).hostname; } catch (_) { return ''; }
        })();
        const shortTitle = (c.title || '').slice(0, 5);
        html += `<a class=\"cite-link\" href=\"${escapeHtml(c.url)}\" target=\"_blank\" rel=\"noopener\" title=\"${escapeAttr(c.title)}\">`;
        html += `<img class=\"cite-favicon\" src=\"https://www.google.com/s2/favicons?domain=${escapeHtml(domain)}&sz=16\" width=\"16\" height=\"16\" loading=\"lazy\">`;
        html += `<span class=\"cite-label\">[${i + 1}] ${escapeHtml(shortTitle)}</span>`;
        html += '</a>';
    });
    html += '</div>';
    return html;
}

function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function scrollToBottom() {
    requestAnimationFrame(() => { chatArea.scrollTop = chatArea.scrollHeight; });
}

function hideTyping() { typingIndicator.classList.remove('visible'); }
function showTyping() { typingIndicator.classList.add('visible'); }

// ═══════════════════════════════════════════════════════════
// Audio Playback (Web Audio API — PCM 44100Hz Int16 mono)
// ═══════════════════════════════════════════════════════════
const PCM_RATE = 44100;

function getAudioCtx() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: PCM_RATE });
    }
    if (audioContext.state === 'suspended') audioContext.resume();
    return audioContext;
}

function pcmToBuffer(base64) {
    const ctx = getAudioCtx();
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);
    const buf = ctx.createBuffer(1, int16.length, PCM_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 32768;
    return buf;
}

function enqueueAudio(base64) {
    if (!base64) return;
    audioQueueItems.push(base64);
    audioIndicator.classList.add('visible');
    playNextAudio();
}

function playNextAudio() {
    if (isAudioPlaying || audioQueueItems.length === 0) return;
    isAudioPlaying = true;
    const b64 = audioQueueItems.shift();
    try {
        const buf = pcmToBuffer(b64);
        const ctx = getAudioCtx();
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.onended = () => {
            activeAudioSrc = null;
            isAudioPlaying = false;
            if (audioQueueItems.length === 0) audioIndicator.classList.remove('visible');
            playNextAudio();
        };
        activeAudioSrc = src;
        src.start(0);
    } catch (e) {
        console.error('Audio error:', e);
        isAudioPlaying = false;
        playNextAudio();
    }
}

function clearAudioQueue() {
    if (activeAudioSrc) {
        try { activeAudioSrc.stop(); } catch (_) {}
        activeAudioSrc = null;
    }
    audioQueueItems = [];
    isAudioPlaying = false;
    audioIndicator.classList.remove('visible');
}

// ═══════════════════════════════════════════════════════════
// Voice Call (PCM WAV recording → Fish Audio ASR)
// ═══════════════════════════════════════════════════════════
// Fish Audio ASR doesn't support WebM Opus — we record raw PCM
// and encode as WAV (universally supported).
const ASR_URL = '/api/asr';
const ASR_SAMPLE_RATE = 16000; // 16kHz, standard for speech recognition

let _recordCtx = null;
let _recordStream = null;
let _recordSamples = [];
let _recordProcessor = null;

function encodeWAV(samples, sampleRate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);

    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF');
    v.setUint32(4, 36 + samples.length * 2, true);
    w(8, 'WAVE');
    w(12, 'fmt ');
    v.setUint32(16, 16, true);       // chunk size
    v.setUint16(20, 1, true);        // PCM
    v.setUint16(22, 1, true);        // mono
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);        // block align
    v.setUint16(34, 16, true);       // 16-bit
    w(36, 'data');
    v.setUint32(40, samples.length * 2, true);

    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
}

async function startRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        _recordStream = stream;

        const ctx = new AudioContext({ sampleRate: ASR_SAMPLE_RATE });
        _recordCtx = ctx;

        const source = ctx.createMediaStreamSource(stream);
        const processor = ctx.createScriptProcessor(4096, 1, 1);
        _recordProcessor = processor;
        _recordSamples = [];

        processor.onaudioprocess = (e) => {
            const data = e.inputBuffer.getChannelData(0);
            for (let i = 0; i < data.length; i++) _recordSamples.push(data[i]);
        };

        source.connect(processor);
        processor.connect(ctx.destination);

        isRecording = true;
        updateCallUI();
        callStatus.textContent = '正在听...';
        callUserText.textContent = '';
        callAssistantText.textContent = '';
        callAssistantText.style.opacity = '1';

    } catch (e) {
        console.error('Mic error:', e.name, e.message);
        if (e.name === 'NotAllowedError') {
            callStatus.textContent = '请允许麦克风权限后重试';
        } else if (e.name === 'NotFoundError') {
            callStatus.textContent = '未检测到麦克风设备';
        } else if (e.name === 'NotSupportedError') {
            callStatus.textContent = '浏览器不支持录音，请用Chrome';
        } else {
            callStatus.textContent = '麦克风错误: ' + (e.message || e.name || '未知');
        }
        isRecording = false;
        updateCallUI();
    }
}

async function stopRecording() {
    if (!isRecording) return;

    // Disconnect audio graph
    if (_recordProcessor) {
        _recordProcessor.disconnect();
        _recordProcessor = null;
    }
    if (_recordStream) {
        _recordStream.getTracks().forEach(t => t.stop());
        _recordStream = null;
    }
    if (_recordCtx) {
        _recordCtx.close();
        _recordCtx = null;
    }

    isRecording = false;
    updateCallUI();

    const samples = _recordSamples;
    _recordSamples = [];

    if (samples.length < ASR_SAMPLE_RATE * 0.3) { // < 0.3 seconds
        callStatus.textContent = '太短了，再说一遍？';
        if (isCallActive) setTimeout(() => startRecording(), 800);
        return;
    }

    callStatus.textContent = '识别中...';
    callAssistantText.textContent = '';

    try {
        const wav = encodeWAV(samples, ASR_SAMPLE_RATE);
        const formData = new FormData();
        formData.append('audio', wav, 'recording.wav');
        const r = await fetch(ASR_URL, { method: 'POST', body: formData });
        const result = await r.json();

        if (result.text && result.text.trim()) {
            callUserText.textContent = '"' + result.text + '"';
            callStatus.textContent = '张雪峰正在回复...';
            callAvatar.classList.add('speaking');

            sendChatMessage(result.text.trim());

            setTimeout(() => {
                if (isCallActive && !isProcessing) {
                    callAvatar.classList.remove('speaking');
                    callStatus.textContent = '继续说话...';
                    startRecording();
                }
            }, 1500);
        } else {
            callStatus.textContent = '没听清，再说一遍？';
            if (isCallActive) setTimeout(() => startRecording(), 800);
        }
    } catch (e) {
        console.error('ASR error:', e);
        callStatus.textContent = '识别失败，再试一次';
        if (isCallActive) setTimeout(() => startRecording(), 800);
    }
}

function updateCallUI() {
    btnCallMic.classList.toggle('recording', isRecording);
    callWaveform.classList.toggle('active', isRecording);
}

function openCall() {
    isCallActive = true;
    callOverlay.classList.add('active');
    btnCall.classList.add('active');
    callStatus.textContent = '点击麦克风开始说话';
    callUserText.textContent = '';
    callAssistantText.textContent = '';
    callStartTime = Date.now();

    callTimer = setInterval(() => {
        const s = Math.floor((Date.now() - callStartTime) / 1000);
        callTimerEl.textContent =
            String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
    }, 1000);

    // Don't auto-start recording — user must tap mic button.
    // This ensures getUserMedia is called from a direct user gesture
    // (required by mobile browsers for mic permission prompt).
}

function closeCall() {
    isCallActive = false;
    stopRecording();
    callOverlay.classList.remove('active');
    btnCall.classList.remove('active');
    callAvatar.classList.remove('speaking');
    callWaveform.classList.remove('active');
    callUserText.textContent = '';
    callAssistantText.textContent = '';
    callStatus.textContent = '点击麦克风开始说话';
    callTimerEl.textContent = '';
    isRecording = false;

    if (callTimer) { clearInterval(callTimer); callTimer = null; }
    clearAudioQueue();
}

// ═══════════════════════════════════════════════════════════
// Send Chat Message
// ═══════════════════════════════════════════════════════════
function sendChatMessage(text) {
    if (!text.trim() || isProcessing) return;

    isProcessing = true;
    updateUI();
    clearAudioQueue();
    finalizeStreaming();

    addUserBubble(text);

    // Voice calls always use voice mode for responses
    const useVoice = voiceMode || isCallActive;
    if (!useVoice) showTyping();

    send({
        type: 'chat',
        text: text,
        mode: useVoice ? 'voice' : 'text',
    });

    messageInput.value = '';
    messageInput.style.height = 'auto';
}

function updateUI() {
    if (isProcessing) {
        btnSend.style.display = 'none';
        btnStop.style.display = 'flex';
        messageInput.disabled = true;
        messageInput.style.opacity = '0.5';
    } else {
        btnSend.style.display = 'flex';
        btnStop.style.display = 'none';
        messageInput.disabled = false;
        messageInput.style.opacity = '1';
    }
}

// ═══════════════════════════════════════════════════════════
// Event Listeners
// ═══════════════════════════════════════════════════════════

// Send
btnSend.addEventListener('click', () => sendChatMessage(messageInput.value));

// Stop button — stops LLM generation + TTS playback
btnStop.addEventListener('click', () => {
    stopRequested = true;
    clearAudioQueue();
    // Tell server to cancel generation
    send({ type: 'stop' });
    isProcessing = false;
    updateUI();
    finalizeStreaming();
    hideTyping();
    setStatus('online', '在线');
});
messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage(messageInput.value);
    }
});
messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
});

// Voice toggle
btnVoiceToggle.addEventListener('click', () => {
    voiceMode = !voiceMode;
    btnVoiceToggle.classList.toggle('active', voiceMode);
    modeLabel.textContent = voiceMode ? '🎤 语音模式' : '📝 文字模式';
    modeLabel.classList.toggle('voice-mode', voiceMode);
    messageInput.placeholder = voiceMode
        ? '语音模式 — 张雪峰会用语音回复你...'
        : '有啥问题尽管问... (Enter发送)';
});

// Call
btnCall.addEventListener('click', () => isCallActive ? closeCall() : openCall());
btnCallEnd.addEventListener('click', () => closeCall());
btnCallMic.addEventListener('click', () => {
    if (!isCallActive) return;
    if (isRecording) stopRecording();
    else startRecording();
});

// Sidebar
btnNewChat.addEventListener('click', newConversation);
btnMenu.addEventListener('click', () => sidebar.classList.toggle('open'));

// Quick action buttons
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.quick-btn');
    if (btn) {
        const text = btn.dataset.text;
        if (text) sendChatMessage(text);
    }
});

// Close sidebar on mobile when clicking outside
document.addEventListener('click', (e) => {
    if (!sidebar.contains(e.target) && !btnMenu.contains(e.target) && sidebar.classList.contains('open')) {
        sidebar.classList.remove('open');
    }
});

// ── Citation tooltip ──────────────────────────────────
let citeTooltip = null;

function ensureCiteTooltip() {
    if (!citeTooltip) {
        citeTooltip = document.createElement('div');
        citeTooltip.id = 'citeTooltip';
        citeTooltip.innerHTML =
            '<div class="cite-tip-title"></div>' +
            '<div class="cite-tip-url"></div>' +
            '<div class="cite-tip-snippet"></div>';
        document.body.appendChild(citeTooltip);
    }
    return citeTooltip;
}

function showCiteTooltip(badge, ev) {
    const tip = ensureCiteTooltip();
    tip.querySelector('.cite-tip-title').textContent = badge.dataset.title || '';
    tip.querySelector('.cite-tip-url').textContent = badge.dataset.url || '';
    tip.querySelector('.cite-tip-snippet').textContent = badge.dataset.snippet || '';
    tip.classList.add('visible');

    // Position near the badge
    const rect = badge.getBoundingClientRect();
    let left = rect.left + rect.width / 2;
    let top = rect.top - 8;
    // Keep within viewport
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    tip.style.transform = 'translate(-50%, -100%)';

    // Adjust if off-screen
    const tipRect = tip.getBoundingClientRect();
    if (tipRect.left < 8) tip.style.left = (left - tipRect.left + 8) + 'px';
    if (tipRect.right > window.innerWidth - 8) {
        tip.style.left = (left - (tipRect.right - window.innerWidth + 8)) + 'px';
    }
    if (tipRect.top < 8) {
        tip.style.top = (rect.bottom + 8) + 'px';
        tip.style.transform = 'translate(-50%, 0)';
    }
}

function hideCiteTooltip() {
    if (citeTooltip) citeTooltip.classList.remove('visible');
}

chatArea.addEventListener('mouseover', (e) => {
    const badge = e.target.closest('.cite-badge');
    if (badge && badge.dataset.url) showCiteTooltip(badge, e);
});
chatArea.addEventListener('mouseout', (e) => {
    if (e.target.closest('.cite-badge')) hideCiteTooltip();
});

// Citation badge click — open in new tab, never replace current page
chatArea.addEventListener('click', (e) => {
    const badge = e.target.closest('.cite-badge');
    if (!badge) return;
    e.preventDefault();
    e.stopPropagation();
    const url = badge.dataset.url;
    if (!url) return;
    // Create a real <a> in the DOM so the browser treats it as user-initiated
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 100);
});

// ═══════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════
function formatTime(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
    if (diff < 604800000) return Math.floor(diff / 86400000) + '天前';
    return `${d.getMonth()+1}/${d.getDate()}`;
}

// ═══════════════════════════════════════════════════════════
// Theme (dark / light) — persisted in localStorage
// ═══════════════════════════════════════════════════════════
const THEME_KEY = 'ozxf-theme';

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const label = document.querySelector('.theme-toggle-label');
    if (label) label.textContent = theme === 'light' ? '深色模式' : '浅色模式';
}

function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function toggleTheme() {
    const next = currentTheme() === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
}

// ═══════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════
function init() {
    // Restore saved theme (default dark)
    let saved = 'dark';
    try { saved = localStorage.getItem(THEME_KEY) || 'dark'; } catch (_) {}
    applyTheme(saved);

    const btnThemeToggle = document.getElementById('btnThemeToggle');
    if (btnThemeToggle) btnThemeToggle.addEventListener('click', toggleTheme);

    connectWS();
    messageInput.focus();
    window.addEventListener('beforeunload', () => {
        if (ws) ws.close();
        if (audioContext) audioContext.close();
    });
}

init();
