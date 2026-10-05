// ─── INSTANT RELOAD GUARD ────────────────────────────────────────────────────
// Run synchronously before anything else — zero flash of join screen
;(function() {
    try {
        const saved = sessionStorage.getItem('activeCall');
        if (saved) {
            const d = JSON.parse(saved);
            if (d && d.callId) {
                const js = document.getElementById('joinScreen');
                const cs = document.getElementById('callScreen');
                if (js) { js.classList.remove('active'); js.style.display = 'none'; }
                if (cs) { cs.classList.add('active'); }
            }
        } else {
            // If callId in URL, hide join screen immediately (will auto-join on load)
            const params = new URLSearchParams(window.location.search);
            if (params.get('callId')) {
                const js = document.getElementById('joinScreen');
                const cs = document.getElementById('callScreen');
                if (js) { js.classList.remove('active'); js.style.display = 'none'; }
                if (cs) { cs.classList.add('active'); }
            }
        }
    } catch(e) { /* ignore */ }
})();

// ─── CONFIG ───────────────────────────────────────────────────────────────────
// SIGNALING_URL is set in index.html from window.APP_CONFIG
// Falls back to same origin (works when server also serves the frontend)
const SIGNALING_URL = (window.APP_CONFIG && window.APP_CONFIG.SIGNALING_URL)
    || window.location.origin;

// ─── SOCKET ───────────────────────────────────────────────────────────────────
const socket = io(SIGNALING_URL, {
    transports: ['websocket'],          // WebSocket only — no polling fallback
    reconnectionDelay: 500,             // Start reconnect faster
    reconnectionDelayMax: 5000,         // Max 5s (was 16s)
    randomizationFactor: 0.3,
    timeout: 8000
});
window.socket = socket;

// ─── DOM REFS ─────────────────────────────────────────────────────────────────
const joinScreen        = document.getElementById('joinScreen');
const callScreen        = document.getElementById('callScreen');
const callIdInput       = document.getElementById('callIdInput');
const joinBtn           = document.getElementById('joinBtn');
const hangupBtn         = document.getElementById('hangupBtn');
const muteBtn           = document.getElementById('muteBtn');
const videoBtn          = document.getElementById('videoBtn');
const switchCameraBtn   = document.getElementById('switchCameraBtn');
const screenShareBtn    = document.getElementById('screenShareBtn');
const statusSpan        = document.getElementById('status');
const statusIndicator   = document.getElementById('statusIndicator');
const callTimer         = document.getElementById('callTimer');
const errorNotification = document.getElementById('errorNotification');
const remoteVideo       = document.getElementById('remoteVideo');
const localVideo        = document.getElementById('localVideo');
const qualityIndicator  = document.getElementById('qualityIndicator');
const qualityText       = document.getElementById('qualityText');

// ─── STATE ───────────────────────────────────────────────────────────────────
let localStream     = null;
let pc              = null;
let currentCallId   = null;
let sessionId       = crypto.randomUUID();

let polite                      = false;
let makingOffer                 = false;
let ignoreOffer                 = false;
let isSettingRemoteAnswerPending = false;
let pendingCandidates           = [];

let appState   = 'IDLE';
let manualHangup = false;
let isMuted    = false;
let isVideoMuted = false;
let currentFacingMode = 'user';
let isScreenSharing  = false;
let screenStream     = null;
let isRemoteScreenSharing = false;

let timerInterval    = null;
let secondsConnected = 0;
let credentialsFetched = false;
let rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let statsInterval = null;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function log(msg, ...args) {
    console.log(`[WEBRTC] ${msg}`, ...args);
}

let errorTimer = null;
function showError(msg, duration = 6000) {
    errorNotification.textContent = msg;
    errorNotification.classList.remove('hidden');
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => errorNotification.classList.add('hidden'), duration);
}

function switchScreen(screen) {
    if (screen === 'call') {
        joinScreen.classList.remove('active');
        joinScreen.style.display = '';
        callScreen.classList.add('active');
    } else {
        callScreen.classList.remove('active');
        joinScreen.style.display = '';   // reset any inline hide
        joinScreen.classList.add('active');
    }
}

function updateTimerDisplay() {
    const m = Math.floor(secondsConnected / 60).toString().padStart(2, '0');
    const s = (secondsConnected % 60).toString().padStart(2, '0');
    callTimer.textContent = `${m}:${s}`;
    
    // Auto-save state for seamless reload
    if (currentCallId) {
        const prev = JSON.parse(sessionStorage.getItem('activeCall') || '{}');
        sessionStorage.setItem('activeCall', JSON.stringify({
            ...prev,
            callId: currentCallId,
            sessionId: sessionId,
            secondsConnected: secondsConnected,
            isMuted: isMuted,
            isVideoMuted: isVideoMuted,
            isRemoteScreenSharing: isRemoteScreenSharing
        }));
    }
}

function startTimer() {
    if (!timerInterval) {
        timerInterval = setInterval(() => { secondsConnected++; updateTimerDisplay(); }, 1000);
    }
}

function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
}

function startStatsMonitor() {
    if (statsInterval) clearInterval(statsInterval);
    statsInterval = setInterval(async () => {
        if (!pc || appState !== 'CONNECTED') { clearInterval(statsInterval); statsInterval = null; return; }
        try {
            const stats = await pc.getStats();
            stats.forEach(report => {
                if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                    const rtt = report.currentRoundTripTime;
                    if (rtt !== undefined) {
                        let quality = 'Good';
                        if (rtt > 0.3) quality = 'Poor';
                        else if (rtt > 0.1) quality = 'Fair';
                        qualityText.textContent = quality;
                        qualityIndicator.classList.remove('hidden');
                    }
                }
            });
        } catch (_) { /* ignore */ }
    }, 5000);
}

// ─── STATE MACHINE ────────────────────────────────────────────────────────────
const callingOverlay = document.getElementById('callingOverlay');

function showCallingOverlay() {
    if (!callingOverlay) return;
    try {
        const p = JSON.parse(sessionStorage.getItem('callPartner') || '{}');
        const callData = JSON.parse(sessionStorage.getItem('activeCall') || '{}');
        const isCaller = callData.isCaller === true;
        if (isCaller && p.first_name) {
            if (p.profile_photo) {
                document.getElementById('callingAvatar').innerHTML = `<img src="${p.profile_photo}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
                document.getElementById('callingAvatar').style.background = 'transparent';
            } else {
                const initials = ((p.first_name||'')[0]||'') + ((p.last_name||'')[0]||'');
                document.getElementById('callingAvatar').textContent = initials.toUpperCase();
                document.getElementById('callingAvatar').style.background = 'linear-gradient(135deg,#7c6cff,#a855f7)';
            }
            const safeName = ((p.first_name||'') + ' ' + (p.last_name||'')).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
            const badgeHtml = p.is_verified ? `<span class="verified-badge" style="margin-left:4px" title=""><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="12" fill="#1d9bf0"/><path d="M9.5 16.5l-3-3 1.4-1.4 1.6 1.6 5.6-5.6 1.4 1.4z" fill="#fff"/></svg><span class="badge-tooltip">Verified Account</span></span>` : '';
            document.getElementById('callingName').innerHTML = `<div style="display:flex;align-items:center;justify-content:center;">${safeName}${badgeHtml}</div>`;
            document.getElementById('callingType').textContent = callData.isVideoMuted ? '📞 Voice Call' : '📹 Video Call';
            callingOverlay.style.display = 'flex';
            return;
        }
    } catch(e) {}
    callingOverlay.style.display = 'none';
}

function hideCallingOverlay() {
    if (callingOverlay) callingOverlay.style.display = 'none';
}

function changeAppState(newState, uiMsg) {
    if (manualHangup && newState !== 'ENDED' && newState !== 'IDLE') return;
    appState = newState;

    statusSpan.textContent = uiMsg || newState;
    statusIndicator.className = 'status-dot ' + newState.toLowerCase();
    document.body.dataset.state = newState;

    if (newState === 'CONNECTED') {
        // Cancel caller watchdog — call was answered
        if (window._callerWatchdog) { clearTimeout(window._callerWatchdog); window._callerWatchdog = null; }
        hideCallingOverlay();
        startTimer();
        startStatsMonitor();
        qualityIndicator.classList.remove('hidden');
        document.querySelector('.video-controls').style.display = 'flex';
    } else if (newState === 'CONNECTING') {
        showCallingOverlay();
        document.querySelector('.video-controls').style.display = 'flex';
    } else if (newState === 'INCOMING') {
        document.querySelector('.video-controls').style.display = 'none';
    } else if (['ENDED', 'FAILED', 'IDLE'].includes(newState)) {
        hideCallingOverlay();
        stopTimer();
        clearInterval(statsInterval);
        statsInterval = null;
        qualityIndicator.classList.add('hidden');
        document.querySelector('.video-controls').style.display = 'flex';
    }
}

// ─── TURN CREDENTIALS ─────────────────────────────────────────────────────────
async function fetchTurnCredentials() {
    if (credentialsFetched) return;
    
    const cached = sessionStorage.getItem('turn_credentials');
    if (cached) {
        try {
            const data = JSON.parse(cached);
            if (Date.now() < data.expiry) {
                rtcConfig = data.rtcConfig;
                credentialsFetched = true;
                log('Used cached TURN credentials');
                return;
            }
        } catch(e) {}
    }

    try {
        const res  = await fetch(`${SIGNALING_URL}/api/turn-credentials`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        rtcConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                {
                    urls:       data.urls,
                    username:   data.username,
                    credential: data.credential
                }
            ]
        };
        credentialsFetched = true;
        
        sessionStorage.setItem('turn_credentials', JSON.stringify({
            expiry: (data.expiry_timestamp * 1000) - 300000, // 5 minutes before expiry
            rtcConfig: rtcConfig
        }));
        
        log(`TURN credentials fetched, expiry=${data.expiry_timestamp}`);
    } catch (e) {
        log('TURN credential fetch failed:', e.message);
        showError('Voice relay service unavailable. Using direct connection.');
    }
}

// ─── RECOVERY MANAGER ─────────────────────────────────────────────────────────
const RecoveryManager = {
    retryCount:   0,
    rebuildCount: 0,
    maxIceRestarts: 3,
    maxRebuilds:    2,
    graceTimer: null,
    uiWarningTimer: null,
    lock: false,

    reset() {
        this.retryCount   = 0;
        this.rebuildCount = 0;
        this.lock         = false;
        clearTimeout(this.graceTimer);
        clearTimeout(this.uiWarningTimer);
        this.graceTimer = null;
        this.uiWarningTimer = null;
    },

    handleOffline() {
        if (['IDLE', 'ENDED', 'FAILED'].includes(appState) || manualHangup) return;
        log('[RECOVERY] NETWORK_OFFLINE');
        changeAppState('RECONNECTING', 'Internet lost. Reconnecting...');
    },

    handleOnline() {
        if (['IDLE', 'ENDED', 'FAILED'].includes(appState) || manualHangup) return;
        log('[RECOVERY] NETWORK_ONLINE');
        if (pc && ['connected', 'completed'].includes(pc.iceConnectionState)) {
            changeAppState('CONNECTED', 'Connected again');
        }
    },

    handleDisconnected() {
        if (manualHangup) return;
        log('[RECOVERY] WEBRTC_DISCONNECTED — grace period starting');
        
        clearTimeout(this.graceTimer);
        clearTimeout(this.uiWarningTimer);
        
        this.uiWarningTimer = setTimeout(() => {
            if (appState !== 'ENDED' && appState !== 'FAILED') {
                changeAppState('DEGRADED', 'Connection unstable...');
            }
        }, 3000);
        
        this.graceTimer = setTimeout(() => {
            if (pc && !['connected', 'completed'].includes(pc.iceConnectionState)) {
                this.handleFailed();
            }
        }, 4000);
    },

    handleConnected() {
        log('[RECOVERY] WEBRTC_CONNECTED');
        this.reset();
        changeAppState('CONNECTED', 'Connected');
    },

    handleFailed() {
        if (manualHangup || this.lock || !pc) return;
        log('[RECOVERY] WEBRTC_FAILED');

        if (this.retryCount < this.maxIceRestarts) {
            this.retryCount++;
            const delay = (Math.pow(2, this.retryCount - 1) * 1000) + (Math.random() * 500);
            log(`[RECOVERY] ICE restart attempt ${this.retryCount} in ${Math.round(delay)}ms`);
            this.lock = true;
            setTimeout(() => {
                this.lock = false;
                if (manualHangup || !pc) return;
                changeAppState('ICE_RESTARTING', 'Restoring call...');
                try { pc.restartIce(); } catch (e) { log('[RECOVERY] restartIce failed', e.message); }
            }, delay);

        } else if (this.rebuildCount < this.maxRebuilds) {
            this.rebuildCount++;
            const delay = 3000 + Math.random() * 1000;
            log(`[RECOVERY] Rebuild attempt ${this.rebuildCount} in ${Math.round(delay)}ms`);
            this.lock = true;
            setTimeout(() => {
                this.lock = false;
                if (manualHangup) return;
                changeAppState('RECOVERING', 'Trying another route...');
                rebuildConnection();
            }, delay);

        } else {
            log('[RECOVERY] All attempts exhausted');
            changeAppState('FAILED', "Couldn't restore the call. Please try again.");
            cleanupCall(false);
        }
    }
};

window.addEventListener('offline', () => RecoveryManager.handleOffline());
window.addEventListener('online',  () => RecoveryManager.handleOnline());

// ─── JOIN ─────────────────────────────────────────────────────────────────────
joinBtn.addEventListener('click', async () => {
    const callId = callIdInput.value.trim();
    if (!callId) { showError('Enter a call code to continue.'); return; }

    currentCallId = callId;
    manualHangup  = false;
    sessionId     = crypto.randomUUID();
    secondsConnected = 0;
    updateTimerDisplay();
    RecoveryManager.reset();
    credentialsFetched = false;

    joinBtn.disabled = true;

    await fetchTurnCredentials();

    try {
        if (!localStream) {
            try {
                // Default to AUDIO ONLY (Messenger style)
                localStream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                    video: false
                });
                
                isVideoMuted = true;
                videoBtn.classList.add('active'); // Show slashed icon
                videoBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
                
                // Hide PIP container initially
                const localContainer = document.querySelector('.local-video-container');
                if (localContainer) localContainer.style.display = 'none';
                
                localVideo.srcObject = localStream;
                localVideo.classList.remove('pip-active');
                
                videoBtn.disabled = false;
                switchCameraBtn.disabled = true; // No video initially
                
                // Hide Screen Share button if unsupported (e.g. mobile)
                if (!navigator.mediaDevices.getDisplayMedia) {
                    screenShareBtn.style.display = 'none';
                }
            } catch (err) {
                log('Camera not available or blocked, falling back to audio only', err.message);
                // Fallback to Audio only
                localStream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                    video: false
                });
                isVideoMuted = true;
                videoBtn.classList.add('active'); // Show disabled state
                videoBtn.disabled = true;
                switchCameraBtn.disabled = true;
                const localVideoStatus = document.getElementById('localVideoStatus');
                if (localVideoStatus) localVideoStatus.classList.remove('hidden');
                
                showError('Camera not found or blocked. Joined with Audio only.', 5000);
            }
        }
        switchScreen('call');
        changeAppState('CONNECTING', 'Connecting...');
        hangupBtn.disabled = false;
        
        // Save session for reload
        const prevCall = JSON.parse(sessionStorage.getItem('activeCall') || '{}');
        sessionStorage.setItem('activeCall', JSON.stringify({
            ...prevCall,
            callId: currentCallId,
            sessionId: sessionId
        }));
        socket.emit('join_call', { callId: currentCallId, sessionId: sessionId });
        log('Joined call:', currentCallId);
    } catch (e) {
        log('Media error:', e.message);
        const msg = e.name === 'NotAllowedError'
            ? 'Camera/Microphone access denied. Please allow in browser settings.'
            : 'Could not access Camera/Microphone.';
        showError(msg);
        joinBtn.disabled = false;
    }
});

// ─── HANGUP ───────────────────────────────────────────────────────────────────
hangupBtn.addEventListener('click', () => {
    if (currentCallId && !manualHangup) socket.emit('call_end', { callId: currentCallId });
    cleanupCall(true);
});

// ─── MUTE ─────────────────────────────────────────────────────────────────────
muteBtn.addEventListener('click', async () => {
    if (!localStream) return;
    
    if (!isMuted) {
        // TRULY STOP HARDWARE MIC
        const track = localStream.getAudioTracks()[0];
        if (track) {
            track.enabled = false;
            track.stop();
        }
        isMuted = true;
        muteBtn.classList.add('active');
        muteBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
    } else {
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                video: false
            });
            const newTrack = newStream.getAudioTracks()[0];
            const oldTrack = localStream.getAudioTracks()[0];
            
            if (oldTrack) localStream.removeTrack(oldTrack);
            localStream.addTrack(newTrack);
            
            if (pc) {
                const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
                if (sender) {
                    await sender.replaceTrack(newTrack);
                } else {
                    pc.addTrack(newTrack, localStream);
                }
            }
            isMuted = false;
            muteBtn.classList.remove('active');
            muteBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
        } catch (e) {
            log('Failed to restart mic', e.message);
            isMuted = true;
            muteBtn.classList.add('active');
            showError('Could not access microphone');
        }
    }
    
    // Notify peer
    if (currentCallId) {
        socket.emit('peer_action', { callId: currentCallId, action: 'mute_audio', muted: isMuted });
    }
});

// ─── VIDEO TOGGLE ─────────────────────────────────────────────────────────────
videoBtn.addEventListener('click', async () => {
    if (!localStream) return;
    
    isVideoMuted = !isVideoMuted;
    videoBtn.classList.toggle('active', isVideoMuted);
    
    if (isVideoMuted) {
        const track = localStream.getVideoTracks()[0];
        if (track) {
            track.enabled = false;
            track.stop(); // Truly turn off the hardware camera
        }
        videoBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
        
        // Hide PIP container when video is off
        const localContainer = document.querySelector('.local-video-container');
        if (localContainer) localContainer.style.display = 'none';
        switchCameraBtn.disabled = true;
    } else {
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    facingMode: currentFacingMode,
                    ...window.currentVideoConstraints
                }
            });
            const newTrack = newStream.getVideoTracks()[0];
            const oldTrack = localStream.getVideoTracks()[0];
            
            if (oldTrack) localStream.removeTrack(oldTrack);
            localStream.addTrack(newTrack);
            
            localVideo.srcObject = localStream;
            localVideo.classList.add('pip-active');
            
            if (pc) {
                const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    await sender.replaceTrack(newTrack);
                } else {
                    // Add video track if it didn't exist (started as audio-only)
                    pc.addTrack(newTrack, localStream);
                }
            }
            videoBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`;
            
            // Show PIP container when video is on
            const localContainer = document.querySelector('.local-video-container');
            if (localContainer) localContainer.style.display = 'block';
            switchCameraBtn.disabled = false;
        } catch (e) {
            log('Failed to restart camera', e.message);
            isVideoMuted = true;
            videoBtn.classList.add('active');
            showError('Could not restart camera');
        }
    }
    
    // We don't need local placeholder anymore since container is hidden entirely when off,
    // but we can ensure it's hidden just in case.
    const localVideoStatus = document.getElementById('localVideoStatus');
    if (localVideoStatus) localVideoStatus.classList.add('hidden');
    
    // Notify peer
    if (currentCallId) {
        socket.emit('peer_action', { callId: currentCallId, action: 'mute_video', muted: isVideoMuted });
    }
});

// ─── CAMERA SWITCH ────────────────────────────────────────────────────────────
switchCameraBtn.addEventListener('click', async () => {
    if (!localStream) return;
    switchCameraBtn.disabled = true;
    
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    
    try {
        const newStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                facingMode: currentFacingMode,
                ...window.currentVideoConstraints
            }
        });
        
        const newVideoTrack = newStream.getVideoTracks()[0];
        const oldVideoTrack = localStream.getVideoTracks()[0];
        
        // Replace in RTCPeerConnection if active
        if (pc) {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) {
                await sender.replaceTrack(newVideoTrack);
            }
        }
        
        // Update localStream
        localStream.removeTrack(oldVideoTrack);
        oldVideoTrack.stop();
        localStream.addTrack(newVideoTrack);
        
        // Restore mute state
        newVideoTrack.enabled = !isVideoMuted;
        
    } catch (e) {
        log('Switch camera error:', e.message);
        currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user'; // revert
    } finally {
        switchCameraBtn.disabled = false;
    }
});

// ─── SCREEN SHARE ─────────────────────────────────────────────────────────────
screenShareBtn.addEventListener('click', async () => {
    if (!localStream) return;
    
    if (isScreenSharing) {
        stopScreenSharing();
    } else {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: window.currentVideoConstraints || true,
                audio: false
            });
            const screenTrack = screenStream.getVideoTracks()[0];
            
            // Listen for native "Stop sharing" button
            screenTrack.onended = () => {
                stopScreenSharing();
            };
            
            if (pc) {
                const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    await sender.replaceTrack(screenTrack);
                } else {
                    pc.addTrack(screenTrack, localStream);
                }
            }
            
            // Show it in PIP box
            const tempStream = new MediaStream([screenTrack]);
            localVideo.srcObject = tempStream;
            localVideo.classList.add('pip-active');
            
            const localContainer = document.querySelector('.local-video-container');
            if (localContainer) localContainer.style.display = 'block';
            
            const localVideoStatus = document.getElementById('localVideoStatus');
            if (localVideoStatus) localVideoStatus.classList.add('hidden');
            
            isScreenSharing = true;
            screenShareBtn.classList.add('active');
            
            // If camera was on, turn it off visually
            if (!isVideoMuted) {
                const camTrack = localStream.getVideoTracks()[0];
                if (camTrack) {
                    camTrack.stop();
                    localStream.removeTrack(camTrack);
                }
                isVideoMuted = true;
                videoBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
            }
            
            if (currentCallId) {
                socket.emit('peer_action', { callId: currentCallId, action: 'screen_share', active: true });
                socket.emit('peer_action', { callId: currentCallId, action: 'mute_video', muted: false });
            }
            switchCameraBtn.disabled = true; // Can't switch camera while sharing screen
        } catch (e) {
            log('Screen share failed', e.message);
        }
    }
});

function stopScreenSharing() {
    if (!isScreenSharing) return;
    
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }
    
    isScreenSharing = false;
    screenShareBtn.classList.remove('active');
    
    // We revert to Camera OFF state. 
    const localContainer = document.querySelector('.local-video-container');
    if (localContainer) localContainer.style.display = 'none';
    
    localVideo.srcObject = localStream; // Back to localStream (which has no video track right now)
    
    if (currentCallId) {
        socket.emit('peer_action', { callId: currentCallId, action: 'screen_share', active: false });
        socket.emit('peer_action', { callId: currentCallId, action: 'mute_video', muted: true });
    }
}

function saveCallLogToDB(status, duration) {
    try {
        const savedCallData = JSON.parse(sessionStorage.getItem('activeCall') || '{}');
        const isCaller = savedCallData.isCaller === true;
        const pStr = sessionStorage.getItem('callPartner');
        const token = localStorage.getItem('chet_token') || sessionStorage.getItem('chet_token');
        if (pStr && token) {
            const p = JSON.parse(pStr);
            const API = window.APP_CONFIG?.SIGNALING_URL || window.location.origin;
            if (isCaller) {
                return fetch(`${API}/api/messages`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({
                        to_uid: p.uid,
                        text: JSON.stringify({
                            type: 'call_log',
                            status: status,
                            duration: duration || 0
                        })
                    })
                }).then(async (res) => {
                    if (!res.ok) {
                        const errText = await res.text();
                        alert('DB SAVE ERROR (' + res.status + '): ' + errText);
                    }
                }).catch((err) => {
                    alert('FETCH FAILED: ' + err.message);
                });
            } else {
                sessionStorage.setItem('pendingCallLog', JSON.stringify({ status, duration }));
                return Promise.resolve();
            }
        }
    } catch(e) {
        alert('JS ERROR in saveCallLog: ' + e.message);
    }
    return Promise.resolve();
}

function cleanupCall(isManual = false) {
    log('cleanupCall isManual=' + isManual);
    if (isManual) {
        manualHangup = true;
        changeAppState('ENDED', 'Call ended');
    } else if (appState !== 'FAILED') {
        changeAppState('IDLE', 'Ready');
    }

    // ── Save call log (both caller AND callee save their own copy) ────────────────
    if (currentCallId && !manualHangup_logSaved) {
        manualHangup_logSaved = true;
        const status = secondsConnected > 0 ? 'ended' : 'missed';
        saveCallLogToDB(status, secondsConnected);
    }

    RecoveryManager.reset();

    if (pc) { pc.close(); pc = null; }

    if (localStream && (isManual || appState === 'FAILED')) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
        isMuted = false;
        isVideoMuted = false;
        currentFacingMode = 'user';
        
        muteBtn.classList.remove('active');
        videoBtn.classList.remove('active');
        
        muteBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
        videoBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`;
        
        videoBtn.disabled = false;
        switchCameraBtn.disabled = false;
        localVideo.style.display = 'block';
        
        localVideo.srcObject = null;
        localVideo.classList.remove('pip-active');
    }

    pendingCandidates            = [];
    makingOffer                  = false;
    ignoreOffer                  = false;
    isSettingRemoteAnswerPending = false;
    currentCallId                = null;

    joinBtn.disabled   = false;
    hangupBtn.disabled = true;
    if (remoteVideo) remoteVideo.srcObject = null;
    
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }
    isScreenSharing = false;
    if (screenShareBtn) {
        screenShareBtn.classList.remove('active');
        screenShareBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`;
    }
    
    const remoteVideoStatus = document.getElementById('remoteVideoStatus');
    const remoteMicStatus = document.getElementById('remoteMicStatus');
    const localVideoStatus = document.getElementById('localVideoStatus');
    if (remoteVideoStatus) remoteVideoStatus.classList.add('hidden');
    if (remoteMicStatus) remoteMicStatus.classList.add('hidden');
    if (localVideoStatus) localVideoStatus.classList.add('hidden');

    sessionStorage.removeItem('activeCall');

    // Redirect back to chat with partner so the call log is visible immediately
    const delay = isManual ? 800 : 1500;
    setTimeout(() => {
        try {
            const partner = JSON.parse(sessionStorage.getItem('callPartner') || 'null');
            if (partner && partner.uid) {
                sessionStorage.setItem('chatPartner', JSON.stringify(partner));
                window.location.replace('chat.html');
                return;
            }
        } catch(e) {}
        window.location.replace('home.html');
    }, delay);
}

// ─── REBUILD ──────────────────────────────────────────────────────────────────
function rebuildConnection() {
    log('Rebuilding RTCPeerConnection');
    if (pc) pc.close();
    pc = null;
    pendingCandidates            = [];
    makingOffer                  = false;
    ignoreOffer                  = false;
    isSettingRemoteAnswerPending = false;
    setupWebRTC();
}

// ─── WEBRTC SETUP ─────────────────────────────────────────────────────────────
function setupWebRTC() {
    pc = new RTCPeerConnection(rtcConfig);

    if (localStream) {
        localStream.getTracks().forEach(t => {
            if (isScreenSharing && t.kind === 'video') return;
            pc.addTrack(t, localStream);
        });
    }

    if (isScreenSharing && screenStream) {
        screenStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    }

    pc.ontrack = (event) => {
        log('Remote track received kind=' + event.track.kind);
        const stream = event.streams[0] || new MediaStream([event.track]);
        
        if (remoteVideo.srcObject !== stream) {
            remoteVideo.srcObject = stream;
        }
        
        // Ensure playback starts (iOS requires this)
        remoteVideo.play().catch(e => log('Autoplay blocked:', e.message));
    };

    pc.onicecandidate = ({ candidate }) => {
        if (candidate && !manualHangup) {
            socket.emit('ice_candidate', { callId: currentCallId, candidate });
        }
    };

    pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        log('ICE state:', s);
        if (s === 'connected' || s === 'completed') RecoveryManager.handleConnected();
        else if (s === 'disconnected')               RecoveryManager.handleDisconnected();
        else if (s === 'failed')                     RecoveryManager.handleFailed();
    };

    pc.onnegotiationneeded = async () => {
        try {
            makingOffer = true;
            await pc.setLocalDescription();
            if (!manualHangup) {
                socket.emit('offer', { callId: currentCallId, description: pc.localDescription });
                log('Offer sent');
            }
        } catch (err) {
            log('Negotiation error:', err.message);
        } finally {
            makingOffer = false;
        }
    };
}

// ─── SOCKET EVENTS ────────────────────────────────────────────────────────────
socket.on('connect', () => {
    log('Signaling connected id=' + socket.id);

    // Always register with the server so we can receive chat signals even on index.html
    const _tok = localStorage.getItem('chet_token') || sessionStorage.getItem('chet_token');
    if (_tok) socket.emit('register_user', _tok);

    // Only auto-resume if we are actively in a call (not handled by window.load already)
    if (['IDLE', 'ENDED', 'FAILED'].includes(appState) || manualHangup || !currentCallId) return;
    // Don't fire if we are already handling a window.load resume (pc could be null during setup)
    if (appState === 'CONNECTED' || appState === 'RECONNECTING') {
        log('[RECOVERY] Socket reconnected mid-call, resuming...');
        socket.emit('resume_call', { callId: currentCallId, sessionId }, (res) => {
            if (res && res.status === 'resume_ok') {
                log('[RECOVERY] Session resumed after socket reconnect');
                if (!pc) {
                    polite = true;
                    setupWebRTC();
                }
            } else {
                log('[RECOVERY] Resume failed after socket reconnect');
                changeAppState('FAILED', 'Session expired. Please rejoin.');
                showError('Call session expired. Please start a new call.');
                cleanupCall(false);
            }
        });
    }
});

// ─── CALL REJECTED BY CALLEE ──────────────────────────────────────────────────
socket.on('call_rejected', async () => {
    log('[CALL] Call was rejected by callee');
    await saveCallLogToDB('rejected', 0);
    sessionStorage.removeItem('activeCall');
    manualHangup = true;
    manualHangup_logSaved = true; // already saving as rejected
    if (pc) { pc.close(); pc = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    stopTimer();
    // Go back to chat with this partner
    try {
        const partner = JSON.parse(sessionStorage.getItem('callPartner') || 'null');
        if (partner && partner.uid) {
            sessionStorage.setItem('chatPartner', JSON.stringify(partner));
            window.location.replace('chat.html');
            return;
        }
    } catch(e) {}
    window.location.replace('home.html');
});

// ─── CALL MISSED (no answer) ───────────────────────────────────────────────────
socket.on('call_missed', async () => {
    log('[CALL] Call timed out — no answer');
    await saveCallLogToDB('missed', 0);
    sessionStorage.removeItem('activeCall');
    manualHangup = true;
    manualHangup_logSaved = true;
    if (pc) { pc.close(); pc = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    stopTimer();
    try {
        const partner = JSON.parse(sessionStorage.getItem('callPartner') || 'null');
        if (partner && partner.uid) {
            sessionStorage.setItem('chatPartner', JSON.stringify(partner));
            window.location.replace('chat.html');
            return;
        }
    } catch(e) {}
    window.location.replace('home.html');
});

socket.on('call_ringing', () => {
    log('[CALL] Ringing on receiver side');
    const callingType = document.getElementById('callingType');
    if (callingType) {
        callingType.textContent = 'Ringing...';
    }
});

socket.on('incoming_call', (data) => {
    // If we are already in an active or connecting call:
    if (appState !== 'IDLE' && appState !== 'ENDED' && appState !== 'FAILED') {
        const partner = JSON.parse(sessionStorage.getItem('callPartner') || '{}');
        
        // 1. GLARE (Collision): We are calling someone, and they are calling us at the exact same time
        if (appState === 'CONNECTING' && partner.uid === data.from_uid) {
            log('[CALL] Collision detected! Resolving glare by UID comparison...');
            const myUid = JSON.parse(localStorage.getItem('chet_user') || '{}').uid;
            
            // Tie-breaker: The one with the lexicographically smaller UID yields and accepts the other's call
            if (myUid && myUid < data.from_uid) {
                log('[CALL] I yield. Accepting their incoming call automatically.');
                if (window._callerWatchdog) clearTimeout(window._callerWatchdog);
                
                socket.emit('call_accepted', { to_uid: data.from_uid, callId: data.callId });
                sessionStorage.setItem('activeCall', JSON.stringify({
                    callId: data.callId,
                    sessionId: crypto.randomUUID(),
                    secondsConnected: 0,
                    isMuted: false,
                    isVideoMuted: !data.isVideo,
                    isRemoteScreenSharing: false,
                    isCaller: false
                }));
                // Reload to seamlessly switch from CALLER to CALLEE
                window.location.reload();
            } else {
                log('[CALL] I win the collision. Ignoring their incoming call and waiting for them to yield.');
            }
            return;
        }

        // 2. BUSY: We are already on a call, and someone (same or different) is calling us again.
        log('[CALL] Busy. Rejecting incoming call from ' + data.from_uid);
        socket.emit('call_busy', { to_uid: data.from_uid });
        return;
    }
});

socket.on('call_busy', async () => {
    log('[CALL] Callee is busy on another call');
    await saveCallLogToDB('rejected', 0); // Log it as rejected/missed
    sessionStorage.removeItem('activeCall');
    manualHangup = true;
    manualHangup_logSaved = true;
    if (pc) { pc.close(); pc = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    stopTimer();
    
    // Show busy animation instead of alert
    const callingName = document.getElementById('callingName');
    const callingType = document.getElementById('callingType');
    if (callingName && callingType) {
        callingName.textContent = 'User is Busy';
        callingName.style.color = '#ef4444'; // red
        callingType.innerHTML = `<span style="color: #f87171; font-weight: 500; animation: flashBusy 1s infinite;">They are currently talking to someone else.<br>Please try calling again later.</span>`;
        
        if (!document.getElementById('busyAnim')) {
            const style = document.createElement('style');
            style.id = 'busyAnim';
            style.innerHTML = `@keyframes flashBusy { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }`;
            document.head.appendChild(style);
        }
        
        // Wait 3 seconds then redirect
        setTimeout(() => {
            try {
                const partner = JSON.parse(sessionStorage.getItem('callPartner') || 'null');
                if (partner && partner.uid) {
                    sessionStorage.setItem('chatPartner', JSON.stringify(partner));
                    window.location.replace('chat.html');
                    return;
                }
            } catch(e) {}
            window.location.replace('home.html');
        }, 3000);
    } else {
        alert("They are currently talking to someone else. Please try calling again later.");
        try {
            const partner = JSON.parse(sessionStorage.getItem('callPartner') || 'null');
            if (partner && partner.uid) {
                sessionStorage.setItem('chatPartner', JSON.stringify(partner));
                window.location.replace('chat.html');
                return;
            }
        } catch(e) {}
        window.location.replace('home.html');
    }
});

socket.on('disconnect', (reason) => {
    log('Signaling disconnected:', reason);
    if (!['IDLE', 'ENDED', 'FAILED'].includes(appState) && !manualHangup) {
        changeAppState('RECONNECTING', 'Reconnecting...');
    }
});

socket.on('connect_error', (err) => {
    log('Signaling connection error:', err.message);
});

socket.on('error', (data) => {
    log('Server error:', data.message);
    showError(data.message || 'A server error occurred.');
    if (data.message === 'Room is full') {
        joinBtn.disabled = false;
        switchScreen('join');
    }
});

socket.on('peer_role', ({ polite: isPolite }) => {
    polite = isPolite;
    log('Role assigned polite=' + polite);
});

socket.on('peer_connected', () => {
    log('Peer connected event received — pc=' + (pc ? pc.signalingState : 'null'));
    if (!pc) {
        // Brand new call: first time both peers meet
        changeAppState('CONNECTING', 'Peer connected...');
        setupWebRTC();
    } else {
        // Peer reloaded or reconnected — rebuild WebRTC from scratch
        // We are the NON-reloading side: we are impolite, we send the offer
        log('Peer reconnected/reloaded — rebuilding WebRTC (impolite side sends offer)');
        polite = false;
        rebuildConnection();
    }
});

socket.on('peer_disconnected', () => {
    if (manualHangup) return;
    log('Peer disconnected');
    changeAppState('DEGRADED', 'Peer disconnected...');
    RecoveryManager.handleDisconnected();
});

socket.on('offer', async ({ description }) => {
    if (!pc || manualHangup) return;
    try {
        const collision = description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
        ignoreOffer = !polite && collision;
        if (ignoreOffer) { log('Offer collision — ignored (impolite)'); return; }

        isSettingRemoteAnswerPending = description.type === 'answer';
        
        if (collision) {
            log('Collision resolved via rollback');
            await pc.setLocalDescription({ type: 'rollback' });
            await pc.setRemoteDescription(description);
        } else {
            await pc.setRemoteDescription(description);
        }
        
        isSettingRemoteAnswerPending = false;
        log('Remote description set type=' + description.type);

        if (description.type === 'offer') {
            await pc.setLocalDescription();
            socket.emit('answer', { callId: currentCallId, description: pc.localDescription });
            log('Answer sent');
        }

        for (const c of pendingCandidates) await pc.addIceCandidate(c);
        if (pendingCandidates.length) log(`Flushed ${pendingCandidates.length} queued candidates`);
        pendingCandidates = [];
    } catch (err) {
        log('Error handling offer:', err.message);
    }
});

socket.on('answer', async ({ description }) => {
    if (!pc || manualHangup) return;
    try { 
        await pc.setRemoteDescription(description); 
        log('Remote answer applied'); 
        
        for (const c of pendingCandidates) await pc.addIceCandidate(c);
        if (pendingCandidates.length) log(`Flushed ${pendingCandidates.length} queued candidates`);
        pendingCandidates = [];
    }
    catch (err) { log('Error applying answer:', err.message); }
});

socket.on('ice_candidate', async ({ candidate }) => {
    if (!pc || manualHangup) return;
    try {
        if (!pc.remoteDescription) {
            pendingCandidates.push(candidate);
            log('Candidate queued (no remote desc yet)');
            return;
        }
        await pc.addIceCandidate(candidate);
    } catch (err) {
        if (!ignoreOffer) log('ICE candidate error:', err.message);
    }
});

socket.on('call_end', () => {
    if (manualHangup) return;
    log('Peer ended call');
    changeAppState('ENDED', 'Call ended by peer');
    cleanupCall(false);
});

socket.on('peer_action', (data) => {
    if (data.action === 'mute_audio') {
        const remoteMicStatus = document.getElementById('remoteMicStatus');
        if (remoteMicStatus) {
            if (data.muted) remoteMicStatus.classList.remove('hidden');
            else remoteMicStatus.classList.add('hidden');
        }
    } else if (data.action === 'mute_video') {
        const remoteVideoStatus = document.getElementById('remoteVideoStatus');
        if (remoteVideoStatus) {
            if (data.muted) remoteVideoStatus.classList.remove('hidden');
            else remoteVideoStatus.classList.add('hidden');
        }
    } else if (data.action === 'screen_share') {
        isRemoteScreenSharing = data.active;
        if (data.active) {
            remoteVideo.classList.add('is-screen-share');
        } else {
            remoteVideo.classList.remove('is-screen-share');
        }
    }
    // rebuild_webrtc is no longer used; peer_connected handles the rebuild
});

// ─── AUTO-REJOIN ON RELOAD ────────────────────────────────────────────────────
window.addEventListener('load', async () => {
    const savedCall = sessionStorage.getItem('activeCall');
    const incomingCallStr = sessionStorage.getItem('incomingCallToAnswer');
    
    // ── GLARE RESOLUTION ON LOAD ──
    // If BOTH activeCall (outgoing) and incomingCallToAnswer are present, a collision happened!
    if (savedCall && incomingCallStr) {
        try {
            const outData = JSON.parse(savedCall);
            const inData = JSON.parse(incomingCallStr);
            const partner = JSON.parse(sessionStorage.getItem('callPartner') || '{}');
            const myUid = JSON.parse(localStorage.getItem('chet_user') || '{}').uid;
            
            // If they are calling each other
            if (outData.isCaller && partner.uid === inData.from_uid && myUid) {
                log('[GLARE] Load-time collision detected!');
                if (myUid < inData.from_uid) {
                    // I yield. I discard my outgoing call and AUTO-ACCEPT their incoming call.
                    log('[GLARE] I yield. Auto-accepting their call.');
                    sessionStorage.removeItem('incomingCallToAnswer'); // We won't show the overlay
                    
                    const acceptTheirCall = () => {
                        socket.emit('call_accepted', { to_uid: inData.from_uid, callId: inData.callId });
                        sessionStorage.setItem('activeCall', JSON.stringify({
                            callId: inData.callId,
                            sessionId: crypto.randomUUID(),
                            secondsConnected: 0,
                            isMuted: false,
                            isVideoMuted: !inData.isVideo,
                            isRemoteScreenSharing: false,
                            isCaller: false
                        }));
                        window.location.reload();
                    };
                    
                    if (socket.connected) acceptTheirCall();
                    else socket.once('connect', acceptTheirCall);
                    
                    return; // Stop execution here, we are reloading anyway!
                } else {
                    // I win. I discard their incoming call and proceed as CALLER.
                    log('[GLARE] I win. Acting as caller, ignoring their call.');
                    sessionStorage.removeItem('incomingCallToAnswer');
                }
            }
        } catch(e) {}
    }

    // Re-check incomingCallStr after glare resolution
    const finalIncomingCallStr = sessionStorage.getItem('incomingCallToAnswer');
    if (finalIncomingCallStr) {
        // We arrived here as a CALLEE because chat.html/home.html redirected us
        try {
            const data = JSON.parse(finalIncomingCallStr);
            sessionStorage.removeItem('incomingCallToAnswer'); // prevent loop on reload
            
            // Wait for socket to connect then emit call_ringing so caller knows we are on this screen
            if (socket.connected) socket.emit('call_ringing', { to_uid: data.from_uid });
            else socket.once('connect', () => socket.emit('call_ringing', { to_uid: data.from_uid }));
            
            switchScreen('call');
            changeAppState('INCOMING', 'Incoming Call');
            
            const overlay = document.getElementById('incomingCallOverlay');
            if (overlay) {
                overlay.style.display = 'flex';
                const p = data.caller;
                if (p.profile_photo) {
                    document.getElementById('incomingAvatar').innerHTML = `<img src="${p.profile_photo}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
                    document.getElementById('incomingAvatar').style.background = 'transparent';
                } else {
                    const initials = ((p.first_name||'')[0]||'') + ((p.last_name||'')[0]||'');
                    document.getElementById('incomingAvatar').textContent = initials.toUpperCase();
                    document.getElementById('incomingAvatar').style.background = 'linear-gradient(135deg,#7c6cff,#a855f7)';
                }
                const safeName = ((p.first_name||'') + ' ' + (p.last_name||'')).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
                document.getElementById('incomingName').innerHTML = safeName;
                document.getElementById('incomingType').textContent = data.isVideo ? '📹 Incoming Video Call' : '📞 Incoming Voice Call';
                
                // Progress bar countdown 30s
                const fill = document.getElementById('incomingTimerBar');
                if(fill) {
                    fill.style.transition = 'none';
                    fill.style.width = '100%';
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            fill.style.transition = 'width 30s linear';
                            fill.style.width = '0%';
                        });
                    });
                }
                
                // Set up watchdog to dismiss if missed
                window._incomingWatchdog = setTimeout(() => {
                    overlay.style.display = 'none';
                    window.location.replace('chat.html');
                }, 30000);
            }
            
            document.getElementById('incomingDeclineBtn').onclick = () => {
                clearTimeout(window._incomingWatchdog);
                if (socket.connected) socket.emit('call_reject', { to_uid: data.from_uid });
                document.getElementById('incomingCallOverlay').style.display = 'none';
                sessionStorage.setItem('chatPartner', JSON.stringify({ ...data.caller, uid: data.from_uid }));
                window.location.replace('chat.html');
            };
            
            document.getElementById('incomingAcceptBtn').onclick = () => {
                clearTimeout(window._incomingWatchdog);
                if (socket.connected) socket.emit('call_accepted', { to_uid: data.from_uid, callId: data.callId });
                document.getElementById('incomingCallOverlay').style.display = 'none';
                
                // Accept means we become an activeCall participant!
                sessionStorage.setItem('activeCall', JSON.stringify({
                    callId: data.callId,
                    sessionId: crypto.randomUUID(),
                    secondsConnected: 0,
                    isMuted: false,
                    isVideoMuted: !data.isVideo,
                    isRemoteScreenSharing: false,
                    isCaller: false
                }));
                sessionStorage.setItem('callPartner', JSON.stringify({ ...data.caller, uid: data.from_uid }));
                // Reload this page to let the standard logic take over
                window.location.reload();
            };
            return;
        } catch(e) {}
    }

    if (!savedCall) {
        window.location.replace('home.html');
        return;
    }

    // ── Restore existing session ─────────────────────────────────
    try {
        const data = JSON.parse(savedCall);
        if (!data.callId || !data.sessionId) { sessionStorage.removeItem('activeCall'); window.location.replace('home.html'); return; }

        currentCallId    = data.callId;
        sessionId        = data.sessionId;
        manualHangup     = false;
        manualHangup_logSaved = false; // reset so log is saved when this call ends
        secondsConnected = data.secondsConnected || 0;
        isVideoMuted     = data.isVideoMuted !== false;
        isMuted          = data.isMuted || false;
        isRemoteScreenSharing = data.isRemoteScreenSharing || false;
        RecoveryManager.reset();

        updateTimerDisplay();
        switchScreen('call');
        
        // If this is a brand new outgoing call (seconds=0, isCaller=true), start in CONNECTING (Calling...) state.
        // The WebRTC ICE connection will transition it to CONNECTED when the callee actually answers.
        const isNewOutgoing = (data.isCaller === true && data.secondsConnected === 0);
        const initialState = isNewOutgoing ? 'CONNECTING' : 'CONNECTED';
        changeAppState(initialState, isNewOutgoing ? 'Calling...' : 'Connected');
        
        if (isNewOutgoing) {
            const emitIncomingCall = () => {
                try {
                    const currentMe = JSON.parse(localStorage.getItem('chet_user') || '{}');
                    const partner = JSON.parse(sessionStorage.getItem('callPartner') || '{}');
                    if (partner.uid) {
                        socket.emit('incoming_call', {
                            to_uid: partner.uid,
                            caller: { first_name: currentMe.first_name, last_name: currentMe.last_name, uid: currentMe.uid, profile_photo: currentMe.profile_photo, is_verified: currentMe.is_verified },
                            callId: data.callId,
                            isVideo: !data.isVideoMuted
                        });
                    }
                } catch(e) {}
            };
            if (socket.connected) emitIncomingCall();
            else socket.once('connect', emitIncomingCall);
        }
        
        hangupBtn.disabled = false;
        joinBtn.disabled   = true;

        if (isRemoteScreenSharing) remoteVideo.classList.add('is-screen-share');
        else                        remoteVideo.classList.remove('is-screen-share');

        if (isVideoMuted) {
            videoBtn.classList.add('active');
            videoBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
            const lc = document.querySelector('.local-video-container');
            if (lc) lc.style.display = 'none';
            switchCameraBtn.disabled = true;
        } else {
            const lc = document.querySelector('.local-video-container');
            if (lc) lc.style.display = 'block';
            switchCameraBtn.disabled = false;
        }

        if (isMuted) {
            muteBtn.classList.add('active');
            muteBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
        }

        videoBtn.disabled = false;
        if (!navigator.mediaDevices.getDisplayMedia) screenShareBtn.style.display = 'none';

        await fetchTurnCredentials();
        try {
            if (!isVideoMuted) {
                // Video call — request camera + mic
                localStream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } }
                });
                localVideo.srcObject = localStream;
                localVideo.classList.add('pip-active');
                const lc = document.querySelector('.local-video-container');
                if (lc) lc.style.display = 'block';
                switchCameraBtn.disabled = false;
            } else {
                // Audio-only call — mic only
                localStream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                    video: false
                });
                localVideo.srcObject = localStream;
                localVideo.classList.remove('pip-active');
            }
        } catch (err) {
            log('Media access failed on load:', err.message);
            // Fallback to audio only
            try {
                localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            } catch (e) { log('Audio fallback also failed', e.message); }
        }

        if (localStream) {
            if (isMuted) localStream.getAudioTracks().forEach(t => { t.enabled = false; });
        }

        const doResume = () => {
            log('[RELOAD] Emitting resume_call callId=' + currentCallId);
            socket.emit('resume_call', { callId: currentCallId, sessionId }, (res) => {
                if (res && res.status === 'resume_ok') {
                    log('[RELOAD] resume_ok — setting up WebRTC as POLITE peer');
                    polite = true;
                    setupWebRTC();
                } else {
                    log('[RELOAD] resume_failed — session gone, going to chat');
                    changeAppState('FAILED', 'Session expired.');
                    sessionStorage.removeItem('activeCall');
                    setTimeout(() => {
                        try {
                            const partner = JSON.parse(sessionStorage.getItem('callPartner') || 'null');
                            if (partner && partner.uid) {
                                sessionStorage.setItem('chatPartner', JSON.stringify(partner));
                window.location.replace('chat.html');
                                return;
                            }
                        } catch(e) {}
                        window.location.replace('home.html');
                    }, 1500);
                }
            });
        };

        // ── 20-second caller watchdog: if callee never answers, cleanup and go back ──
        try {
            const callData = JSON.parse(sessionStorage.getItem('activeCall') || '{}');
            if (callData.isCaller === true) {
                window._callerWatchdog = setTimeout(async () => {
                    if (['CONNECTED', 'ENDED', 'FAILED'].includes(appState)) return; // already connected or done
                    log('[WATCHDOG] No answer in 20s — giving up');
                    // Notify callee
                    if (socket.connected) {
                        socket.emit('call_no_answer', {
                            to_uid: JSON.parse(sessionStorage.getItem('callPartner') || '{}').uid
                        });
                    }
                    // Save missed log
                    manualHangup_logSaved = true;
                    await saveCallLogToDB('missed', 0);
                    sessionStorage.removeItem('activeCall');
                    if (pc) { pc.close(); pc = null; }
                    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
                    stopTimer();
                    try {
                        const partner = JSON.parse(sessionStorage.getItem('callPartner') || 'null');
                        if (partner && partner.uid) {
                            sessionStorage.setItem('chatPartner', JSON.stringify(partner));
                window.location.replace('chat.html');
                            return;
                        }
                    } catch(e2) {}
                    window.location.replace('home.html');
                }, 20000);
            }
        } catch(e) {}

        if (socket.connected) doResume();
        else socket.once('connect', doResume);

    } catch (e) {
        log('Auto-restore failed:', e.message);
        sessionStorage.removeItem('activeCall');
        try {
            const partner = JSON.parse(sessionStorage.getItem('callPartner') || 'null');
            if (partner && partner.uid) {
                sessionStorage.setItem('chatPartner', JSON.stringify(partner));
                window.location.replace('chat.html');
                return;
            }
        } catch(e2) {}
        window.location.replace('home.html');
    }
});

// ─── QUALITY CONTROLS ─────────────────────────────────────────────────────────
const qualityConfigs = {
    '144':  { width: { ideal: 256 },  height: { ideal: 144 },  frameRate: { ideal: 15 } },
    '360':  { width: { ideal: 640 },  height: { ideal: 360 },  frameRate: { ideal: 24 } },
    '480':  { width: { ideal: 854 },  height: { ideal: 480 },  frameRate: { ideal: 30 } },
    '720':  { width: { ideal: 1280 }, height: { ideal: 720 },  frameRate: { ideal: 60 } },
    '1080': { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
    '2160': { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 60 } }
};

window.currentVideoConstraints = qualityConfigs['480'];

const qualityBtn = document.getElementById('qualityBtn');
const qualityMenu = document.getElementById('qualityMenu');
const qualityLockToggle = document.getElementById('qualityLockToggle');
let isQualityLocked = false;
// qualityIndicator and qualityText already declared above

if (qualityBtn && qualityMenu) {
    qualityBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        qualityMenu.classList.toggle('hidden');
    });

    document.addEventListener('click', (e) => {
        if (!qualityBtn.contains(e.target) && !qualityMenu.contains(e.target)) {
            qualityMenu.classList.add('hidden');
        }
    });

    if (qualityLockToggle) {
        qualityLockToggle.addEventListener('change', (e) => {
            isQualityLocked = e.target.checked;
            const activeBtn = qualityMenu.querySelector('button.active');
            if (activeBtn) activeBtn.click();
        });
    }

    qualityMenu.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            qualityMenu.querySelectorAll('button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            qualityMenu.classList.add('hidden');
            
            const q = btn.getAttribute('data-quality');
            const conf = qualityConfigs[q];
            
            window.currentVideoConstraints = isQualityLocked ? {
                width: { exact: conf.width.ideal },
                height: { exact: conf.height.ideal },
                frameRate: { exact: conf.frameRate.ideal }
            } : conf;
            
            log(`Quality changed to: ${q}p (Locked: ${isQualityLocked})`);

            let trackToUpdate = null;
            if (isScreenSharing && screenStream) {
                trackToUpdate = screenStream.getVideoTracks()[0];
            } else if (localStream && !isVideoMuted) {
                trackToUpdate = localStream.getVideoTracks()[0];
            }
            
            if (trackToUpdate) {
                try {
                    await trackToUpdate.applyConstraints({
                        ...window.currentVideoConstraints,
                        facingMode: !isScreenSharing ? window.currentFacingMode : undefined
                    });
                    log('Applied new constraints successfully');
                } catch(err) {
                    log('Failed to apply constraints: ' + err.message);
                    if (isQualityLocked) {
                        log('Device does not support exactly ' + q + 'p. Reverting lock.');
                        if (qualityLockToggle) qualityLockToggle.checked = false;
                        isQualityLocked = false;
                        btn.click();
                    }
                }
            }
        });
    });
}

setInterval(async () => {
    if (!pc) return;
    try {
        const stats = await pc.getStats();
        let resText = 'Audio Only';
        let foundVideo = false;

        stats.forEach(report => {
            if (report.type === 'inbound-rtp' && report.kind === 'video') {
                foundVideo = true;
                if (report.frameWidth && report.frameHeight) {
                    resText = `Receive: ${report.frameWidth}x${report.frameHeight} @ ${report.framesPerSecond || 0}fps`;
                }
            }
        });

        if (!foundVideo) {
            stats.forEach(report => {
                if (report.type === 'outbound-rtp' && report.kind === 'video') {
                    foundVideo = true;
                    if (report.frameWidth && report.frameHeight) {
                        resText = `Send: ${report.frameWidth}x${report.frameHeight} @ ${report.framesPerSecond || 0}fps`;
                    }
                }
            });
        }
        
        if (qualityIndicator) {
            qualityIndicator.classList.remove('hidden');
            qualityText.textContent = resText;
        }
    } catch(e) {}
}, 2000);
