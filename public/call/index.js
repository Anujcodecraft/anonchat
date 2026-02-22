// public/call/index.js
// Call-specific functionality - UI updates based on real backend events

import { showToast, user_state } from '../utils.js';
import { getSocket, getUserId, setUserId, getInstanceId, setInstanceId } from '../app.js';

// Call state
let socket = null;
let userId = null;
let roomId = null;
let partnerId = null;
let callRole = null;
let partnerData = null;
let isCallActive = false;
let nonHumanMatch = false;
let waitingTimer = null;
let retryTimer = null;
let currentWant = localStorage.getItem("want");
console.log("current ", currentWant);
if(!currentWant || currentWant==='chat'){
    currentWant = localStorage.setItem("want", "call");
}

// WebRTC state
let peerConnection = null;
let localStream = null;
let remoteStream = null;
let pendingIceCandidates = [];
let remoteDescriptionSet = false;

// UI State
let isWaitingForMatch = false;
let callTimerInterval = null;
let callSeconds = 0;
let isMuted = false;
let loudMode = false;
let isFloatingMinimized = false;
let searchTimeInterval = null;
let searchTimeSeconds = 0;
let disableMinimizeFromFloating = false;

// Dragging variables
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let floatingWindowPos = { x: 30, y: 90 };

// DOM Elements
let setupPage = null;
let callPage = null;
let floatingCallWindow = null;
let usernameInput = null;
let genderCards = null;
let partnerGenderCards = null;
let ageConfirmCheckbox = null;
let startCallBtn = null;
let onlineCountElement = null;
let graceTimer = null;

let botAudio = null;
let botTimeout = null;
let botStopped = false;


// User data
let userData = {
    username: '',
    gender: 'male',
    partnerGender: 'any',
    ageConfirmed: false
};

// const room_state = {
//     OFFER_SENT:"OFFER_SENT",
//     OFFER_RECEIVED:"OFFER_RECEIVED",
//     ANSWER_SENT:"ANSWER_SENT",
//     ANSWER_RECEIVED:"ANSWER_RECEIVED"
//   }

// Initialize the call module
export function initCall() {
    socket = getSocket();
    userId = getUserId();
    
    if (!socket || !socket.connected) {
        setTimeout(initCall, 1000);
        return;
    }
    
    initializeDOMReferences();
    setupEventListeners();
    setupMessageHandlers();
    // console.log("init");
    initializeUIState();
    checkResumeState();
}

function initializeDOMReferences() {
    setupPage = document.getElementById('setupPage');
    callPage = document.getElementById('callPage');
    floatingCallWindow = document.getElementById('floatingCallWindow');
    
    usernameInput = document.getElementById('username');
    genderCards = document.querySelectorAll('.gender-card[data-gender]');
    partnerGenderCards = document.querySelectorAll('.gender-card[data-partnergender]');
    ageConfirmCheckbox = document.getElementById('ageConfirm');
    startCallBtn = document.getElementById('startCall');
    onlineCountElement = document.getElementById('onlineCount');
}

function initializeUIState() {
    showSetupPage();
    
    if (genderCards.length > 0) {
        genderCards[0].classList.add('selected');
        userData.gender = genderCards[0].getAttribute('data-gender');
    }
    
    if (partnerGenderCards.length > 0) {
        partnerGenderCards[2].classList.add('selected');
        userData.partnerGender = partnerGenderCards[2].getAttribute('data-partnergender');
    }
    
    const savedUsername = localStorage.getItem('username');
    if (savedUsername && usernameInput) {
        usernameInput.value = savedUsername;
    }
}

function setupEventListeners() {
    if (startCallBtn) {
        startCallBtn.addEventListener('click', handleStartCall);
    }
    
    if (genderCards) {
        genderCards.forEach(card => {
            card.addEventListener('click', () => {
                const genderType = card.getAttribute('data-gender');
                if (genderType) {
                    genderCards.forEach(c => c.classList.remove('selected'));
                    card.classList.add('selected');
                    userData.gender = genderType;
                }
            });
        });
    }
    
    if (partnerGenderCards) {
        partnerGenderCards.forEach(card => {
            card.addEventListener('click', () => {
                const partnerGenderType = card.getAttribute('data-partnergender');
                if (partnerGenderType) {
                    partnerGenderCards.forEach(c => c.classList.remove('selected'));
                    card.classList.add('selected');
                    userData.partnerGender = partnerGenderType;
                }
            });
        });
    }
    
    if (usernameInput) {
        usernameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                handleStartCall();
            }
        });
    }
    
    // Call control buttons
    const muteBtn = document.getElementById('muteBtn');
    const cutBtn = document.getElementById('cutBtn');
    const skipBtn = document.getElementById('skipBtn');
    const speakerBtn = document.getElementById('speakerBtn');
    const callMinimizeBtn = document.getElementById('callMinimizeBtn');
    
    // Floating window controls
    const floatingMuteBtn = document.getElementById('floatingMuteBtn');
    const floatingEndBtn = document.getElementById('floatingEndBtn');
    const floatingSkipBtn = document.getElementById('floatingSkipBtn');
    const minimizeFloatingBtn = document.getElementById('minimizeFloatingBtn');
    
    if (muteBtn) muteBtn.addEventListener('click', toggleMute);
    if (cutBtn) cutBtn.addEventListener('click', endCall);
    if (skipBtn) skipBtn.addEventListener('click', skipConversation);
    if (speakerBtn) speakerBtn.addEventListener('click', toggleSpeaker);
    
    if (floatingMuteBtn) floatingMuteBtn.addEventListener('click', toggleMute);
    if (floatingEndBtn) floatingEndBtn.addEventListener('click', endCall);
    if (floatingSkipBtn) floatingSkipBtn.addEventListener('click', skipConversation);
    
    if (callMinimizeBtn) {
        callMinimizeBtn.addEventListener('click', minimizeToFloating);
    }
    
    if (minimizeFloatingBtn) {
        minimizeFloatingBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // If currently minimized, clicking should restore and then prevent
            // subsequent minimization from this floating window until user
            // minimizes again from main call view.
            if (isFloatingMinimized) {
                disableMinimizeFromFloating = true;
            }
            toggleFloatingMinimize();
        });
        // Also handle touchend to be extra responsive on mobile
        minimizeFloatingBtn.addEventListener('touchend', (e) => {
            e.stopPropagation();
            if (isFloatingMinimized) disableMinimizeFromFloating = true;
            toggleFloatingMinimize();
        });
    }
    
    setupFloatingWindowDrag();
}

function startGraceTimer(){
    if(graceTimer) return;
    graceTimer = setTimeout(() => {
        if (peerConnection.iceConnectionState === "disconnected") {
          reconnectingCall();
          clearTimeout(graceTimer);
          graceTimer = null;
        }
      }, 4000);
}

function setupMessageHandlers() {
    if (!socket) return;
    
    socket.on('message', (msg) => {
        try {
            console.log("msg ", msg);
            const data = typeof msg === 'string' ? JSON.parse(msg) : msg;
            console.log("data is ", data);
            handleMessage(data);
        } catch (err) {
            console.error('Error parsing message:', err);
        }
    });
    
    socket.on('online_count', (msg)=>{
        handleOnlineCount(msg);
    })

    socket.on('webrtc_offer', (msg, ack) => {
        if (callRole === 'callee' && peerConnection) {
          handleWebRTCOffer(msg.offer, ack);
        }
      });
    
      socket.on('webrtc_answer', (msg, ack) => {
        if (callRole === 'caller' && peerConnection) {
          handleWebRTCAnswer(msg.answer, ack);
        }
      });
    
    socket.on('webrtc_ice', (data) => {
        if (!peerConnection || !data.candidate) return;
        
        if (!remoteDescriptionSet) {
            pendingIceCandidates.push(data.candidate);
        } else {
            peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate))
                .catch(err => console.error('ICE add error:', err));
        }
    });
    
    socket.on('webrtc_connection_state', (data) => {
        console.log("webrtc state chage ", data);
        if (data.state === 'failed' || data.state === 'disconnected' || data.state === 'closed') {
            if(callRole==='caller'){
                if(data.state==='disconnected'){
                    showToast("Buffering Please Wait....", 'info');
                    startGraceTimer();
                }
                else if(data.state === 'failed'){
                    showToast("Buffering Please Wait....", 'info');
                    clearTimeout(graceTimer);
                    graceTimer = null;
                    reconnectingCall();
                }
                else{
                    clearTimeout(graceTimer);
                    graceTimer = null;
                    handleCallDisconnection("High Ping!!! Disconnecting...");
                    resetToWaiting();
                }
            } 
            else if(data.state==='closed'){
                clearTimeout(graceTimer);
                graceTimer = null;
                handleCallDisconnection("High Ping!!! Disconnecting...");
                resetToWaiting();
            }
        }
    });
}

function checkResumeState() {
    const storedRoomId = localStorage.getItem('roomId');
    const storedUserId = localStorage.getItem('userId');
    
    if (storedRoomId && storedUserId && socket) {
        socket.emit('message', JSON.stringify({
            type: 'resume',
            userId: storedUserId,
            roomId: storedRoomId,
            want:currentWant
        }));
        // showWaitingForMatch();
    }
}

function startWaitingRetry() {
    if (retryTimer) return;
    retryTimer = setInterval(() => {
      if (!socket || !socket.connected) return;
      if (!waitingTimer) return;
      const now = Date.now();
      const waitedMs = now - waitingTimer;
      const userId = getUserId();
      const gender = localStorage.getItem("selfGender") || "any";
      const preference = localStorage.getItem("callPreference") || "any";
      const userName = localStorage.getItem("username");
      console.log("waiting time(ms):", waitedMs, "want:", currentWant);
      if (currentWant === "call" && preference==='female' && waitedMs > 10_000 && nonHumanMatch === false) {
        socket.emit("message", JSON.stringify({
          type:"non-human-call",
          userId,
          gender: localStorage.getItem('selfGender') || 'any',
          preference: localStorage.getItem('callPreference') || 'any',
          username:userName
        //   interests: selectedInterests
        }));
        nonHumanMatch = true;
      } else {
        socket.emit("retry_match", {
          userId,
          want: 'call',
          gender,
          preference,
          username:userName
        //   interests: selectedInterests
        }, (err, res) => { 
            if (res && res.ok) {
              console.log("Retry match successful");
            } else if (res && res.reason) {
              console.log("Retry match failed:", res.reason);
            }
          if (err) {
            console.error("Retry match error:", err);
            return;
          }
        });
      }
    }, 10_000 + Math.random() * 5_000);
  }
  
  function stopWaitingRetry() {
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
      waitingTimer = null;
    }
  }
  
  function cleanupBotAudio() {
    if (botTimeout) {
      clearTimeout(botTimeout);
      botTimeout = null;
    }
  
    if (botAudio) {
      botAudio.pause();
      botAudio.currentTime = 0;
      botAudio.src = "";
      botAudio = null;
    }
  }

  
  async function playBotVoice(times) {
    let count = 0;
    botStopped = false;
  
    async function playOnce() {
      if (botStopped || count >= times) {
        cleanupBotAudio();
        socket.emit(
          "message",
          JSON.stringify({
            type: "non-human-call-end",
            roomId: roomId || localStorage.getItem("roomId"),
            userId: userId || localStorage.getItem("userId")
          })
        );
        return;
      }
  
      botAudio = new Audio(`/random?userId=${userId}&ts=${Date.now()}`);
      botAudio.volume = 0.9;
  
      try {
        await botAudio.play();
        count++;
      } catch (err) {
        console.warn("Audio play blocked or failed", err);
        cleanupBotAudio();
        return;
      }
  
      botAudio.onended = () => {
        if (botStopped) return;
  
        const delay = 800 + Math.random() * 1200;
        botTimeout = setTimeout(playOnce, delay);
      };
    }
  
    playOnce();
  }
  
  function stopBotVoice() {
    botStopped = true;
    cleanupBotAudio();
    if (botTimeout) {
      clearTimeout(botTimeout);
      botTimeout = null;
    }
  
    if (botAudio) {
      botAudio.pause();
      botAudio.currentTime = 0;
      botAudio.src = "";
      botAudio = null;
    }
  }
  

function handleStartCall() {
    if (!validateSetup()) {
        return;
    }
    
    userData.username = usernameInput.value.trim();
    userData.ageConfirmed = ageConfirmCheckbox.checked;
    
    localStorage.setItem('username', userData.username);
    localStorage.setItem('selfGender', userData.gender);
    localStorage.setItem('callPreference', userData.partnerGender);
    
    // Show connecting state immediately while socket connection is attempted
    showWaitingForMatch();

    if (socket) {
        sendJoinToRoomEvent({
            userId: userId,
            want: 'call',
            username: userData.username,
            gender: userData.gender,
            preference: userData.partnerGender,
            interests: []
        });
    } else {
        showToast('Connection error. Please refresh the page.', 'error');
    }
}

function validateSetup() {
    if (!usernameInput || !usernameInput.value.trim()) {
        showToast('Please enter a username', 'error');
        if (usernameInput) usernameInput.focus();
        return false;
    }
    
    if (!userData.gender) {
        showToast('Please select your gender', 'error');
        return false;
    }
    
    if (!userData.partnerGender) {
        showToast('Please select the gender of your chat partner', 'error');
        return false;
    }
    
    if (!ageConfirmCheckbox || !ageConfirmCheckbox.checked) {
        showToast('You must confirm that you are 18 years or older to continue', 'error');
        return false;
    }
    
    return true;
}

async function reconnectingCall(){
    if (!peerConnection || peerConnection.signalingState !== "stable" || !userId || !roomId){
        console.log("something is missing ", peerConnection, peerConnection.signalingState, userId, roomId)
        return;
    }

    try {
      const offer = await peerConnection.createOffer({ iceRestart: true });
      await peerConnection.setLocalDescription(offer);
    
    socket.timeout(2000).emit(
        "webrtc_offer",
        { roomId, from: userId, offer: offer },
        (err, res) => {
          if (err || !res.ok) {
            if(err.reason==='ROOM_NOT_FOUND'){
              showToast('Room not found', 'error');
              resetToStart();
              return;
            }
            console.log("Offer failed");
            // dissolve UI / retry
            return;
          }
          console.log("Offer recieved at server");
          // continue WebRTC
        }
      );
} catch (error) {
    console.error('Error creating offer:', error);
}
}

function handleMessage(msg) {
    switch(msg.type) {
        case 'auth_ok':
            handleAuthOk(msg);
            break;
        case 'resume_ok':
            handleResumeOk(msg);
            handlePartnerInfo(msg)
            break;
        case 'resume_failed':
            handleResumeFailed(msg);
            break;
        case 'waiting':
            handleWaiting(msg);
            break;
        case 'matched':
            stopBotVoice();
            handleMatched(msg);
            handlePartnerInfo(msg)
            break;
        case 'partner_left':
            handlePartnerLeft(msg);
            break;
        case 'peer_muted':
            handlePeerMuted(msg);
            break;
        case 'room_closed':
            handleRoomClosed(msg);
            break;
        case 'skipped':
            handleSkipped(msg);
            break;
        case 'partner_info':
            handlePartnerInfo(msg);
            break;
        case 'non_human_call_end':
            console.log("non human cal end");
            showToast("partner left", "info");
            stopCallTimer();
            showWaitingForMatch();
            sendJoinToRoomEvent({
                userId: userId,
                want: 'call',
                username: userData.username,
                gender: userData.gender,
                preference: userData.partnerGender,
                interests: []
            });
            break;
        case 'matched_bot':
            handleBotMatched(msg);
            handlePartnerInfo(msg);
            break;
        case 'error':
            showToast("ERROR", 'error');
            localStorage.removeItem("roomId");
            resetToSetup();
    }
}

function handleAuthOk(msg) {
    userId = msg.userId;
    setUserId(userId);
    localStorage.setItem('userId', userId);
}

function handleResumeOk(msg) {
    userId = msg.userId;
    roomId = msg.roomId;
    partnerId = msg.partnerId;
    callRole = msg.role;
    console.log("data of resume ", userId, roomId, partnerId)
    const userState = msg.state;
    // setUserId(userId);
    
    if (roomId && partnerId && msg.state===user_state.IN_ROOM) {
        isCallActive = true;
        requestPartnerInfo();
        showCallScreen();
        reconnectingCall();
        startCallTimer();
    } else if(msg.state===user_state.WAITING){
        showWaitingForMatch();
    }
    else resetToSetup();
}

function handleResumeFailed(msg) {
    localStorage.removeItem('roomId');
    showSetupPage();
}

function handleWaiting(msg) {
    isWaitingForMatch = true;
    showWaitingForMatch();
}

function handleMatched(msg) {
    roomId = msg.roomId;
    partnerId = msg.partnerId;
    callRole = msg.role;
    
    if (roomId) {
        localStorage.setItem('roomId', roomId);
    }
    
    // Handle partner username from matched event
    if (msg.partnerUserName) {
        const callPartnerName = document.getElementById('callPartnerName');
        const floatingPartnerName = document.getElementById('floatingPartnerName');
        if (callPartnerName) callPartnerName.textContent = msg.partnerUserName;
        if (floatingPartnerName) floatingPartnerName.textContent = msg.partnerUserName;
    }
    
    isWaitingForMatch = false;
    isCallActive = true;
    isMuted = false;
    loudMode = false;
    toggleSpeaker
    hideWaitingMessage();
    
    requestPartnerInfo();
    showCallScreen();
    showToast("Matched", 'success')
    initializeWebRTC();
}
function handleBotMatched(msg) {
    roomId = msg.roomId;
    partnerId = msg.partnerId;
    
    if (roomId) {
        localStorage.setItem('roomId', roomId);
    }
    
    
    isWaitingForMatch = false;
    isCallActive = true;
    hideWaitingMessage();
    showCallScreen();
    startCallTimer();
    showToast("Matched", 'success')
    const playTimes = Math.floor(Math.random() * 3) + 1;
    setTimeout(()=>{
        playBotVoice(playTimes);
    }, 1000+Math.random(0,1)*2000);
}

function handlePartnerLeft(msg) {
    showToast('Partner disconnected', 'info');
    handleCallDisconnection('partner_left');
    resetToWaiting();
}

function handleRoomClosed(msg) {
    showToast('Room closed', 'info');
    handleCallDisconnection('room_closed');
    resetToWaiting();
}

function handleSkipped(msg) {
    showToast('Partner skipped', 'info');
    handleCallDisconnection('skipped');
    resetToWaiting('skipped');
}

function handlePartnerInfo(msg) {
    partnerData = msg;
    
    const callPartnerName = document.getElementById('callPartnerName');
    const videoPartnerName = document.getElementById('videoPartnerName');
    const floatingPartnerName = document.getElementById('floatingPartnerName');
    const callPartnerCountry = document.getElementById('callPartnerCountry');
    const floatingPartnerCountry = document.getElementById('floatingPartnerCountry');
    const callAvatar = document.getElementById('callAvatar');
    
    const displayName = msg.partnerUserName || msg.username || msg.name || 'Stranger';
    
    if (callPartnerName) callPartnerName.textContent = displayName;
    if (videoPartnerName) videoPartnerName.textContent = displayName;
    if (floatingPartnerName) floatingPartnerName.textContent = displayName;
    
    if (callPartnerCountry) callPartnerCountry.textContent = msg.country || 'Unknown';
    if (floatingPartnerCountry) floatingPartnerCountry.textContent = 'Connected';
    
    if (callAvatar) callAvatar.textContent = displayName && displayName !== 'Stranger' ? displayName.charAt(0).toUpperCase() : 'S';
    
    if (msg.flag) {
        const flagElements = document.querySelectorAll('.flag');
        flagElements.forEach(el => {
            el.textContent = msg.flag;
        });
    }
}

function handleOnlineCount(msg) {
    msg = JSON.parse(msg);
    if (onlineCountElement && msg.count) {
        const formattedCount = (msg.count + 190).toLocaleString();
        console.log("msg.count ", msg.count, formattedCount);
        onlineCountElement.textContent = `${formattedCount} online`;
    }
    
    // Update online count in waiting state if visible
    if (isWaitingForMatch && msg.count) {
        const waitingUsersOnlineElement = document.getElementById('waiting-users-online');
        if (waitingUsersOnlineElement) {
            const formattedCount = (msg.count + 190).toLocaleString();
            waitingUsersOnlineElement.textContent = formattedCount;
        }
    }
    
    // Also update online count displayed during connected call
    if (isCallActive && msg.count) {
        const connectedOnlineElement = document.getElementById('connectedOnlineCount');
        if (connectedOnlineElement) {
            const formattedCount = (msg.count+190).toLocaleString();
            console.log("msg.count ", msg.count, formattedCount);
            connectedOnlineElement.textContent = `${formattedCount} online`;
        }
    }
}

async function initializeWebRTC() {
    if (!roomId || !userId || !callRole) return;

    console.log("initialize webrtc ", userId, roomId, callRole);
    
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
              },            
            video: false
        });
        
        const configuration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                {
                urls: "turn:31.97.237.111:3478?transport=udp", // <-- replace with YOUR WSL IP
                username: "webrtcuser",
                credential: "strongpassword"
                },
            ]
        };
        
        peerConnection = new RTCPeerConnection(configuration);
        
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
        
        peerConnection.onicecandidate = (event) => {
            if (event.candidate && socket) {
                socket.emit('webrtc_ice', {
                    roomId,
                    from: userId,
                    candidate: event.candidate,
                });
            }
        };
        
        peerConnection.ontrack = (event) => {
            remoteStream = event.streams[0];
            const remoteAudio = document.getElementById('remoteAudio');
            if (!remoteAudio) {
                const audioElement = document.createElement('audio');
                audioElement.id = 'remoteAudio';
                audioElement.autoplay = true;
                audioElement.volume = loudMode ? 1.0 : 0.11;
                document.body.appendChild(audioElement);
            }
            
            const audio = document.getElementById('remoteAudio');
            audio.srcObject = remoteStream;
        };
        
        peerConnection.onconnectionstatechange = () => {
            const state = peerConnection.connectionState;
            if (state === 'failed' || state === 'disconnected' || state === 'closed') {
                if (socket) {
                    socket.emit('webrtc_connection_state', {
                        roomId,
                        from: userId,
                        state: state,
                    });
                }
                // handleCallDisconnection(state);
                if(callRole==='caller'){
                    if(state==='disconnected'){
                        showToast("Buffering Please Wait....", 'info');
                        startGraceTimer();
                    }
                    else if(state === 'failed'){
                        showToast("Buffering Please Wait....", 'info');
                        if(graceTimer) clearTimeout(graceTimer);
                        graceTimer = null;
                        reconnectingCall();
                    }
                    else{
                        if(graceTimer) clearTimeout(graceTimer);
                        graceTimer = null;
                        handleCallDisconnection("High Ping!!! Disconnecting...");
                        resetToWaiting();
                    }
                }
                else if(state==='closed'){
                    if(graceTimer) clearTimeout(graceTimer);
                    graceTimer = null;
                    handleCallDisconnection("High Ping!!! Disconnecting...");
                    resetToWaiting();
                } 
                // else{
                //     // yha disconncection honga chahiye after trying for certain number of times
                // }
    
            }
        };
        if (callRole === 'caller') {
            const audioTrack = localStream.getAudioTracks()[0];
            if (audioTrack.muted && audioTrack.readyState === 'live') {
                await Promise.race([
                  new Promise(resolve => {
                    const onUnmute = () => {
                      audioTrack.removeEventListener('unmute', onUnmute);
                      resolve();
                    };
                    audioTrack.addEventListener('unmute', onUnmute);
                  }),
                  new Promise(resolve => setTimeout(resolve, 3000)) // safety timeout
                ]);
              }              
            // extra warm-up (critical on first permission)
            await new Promise(r => setTimeout(r, 200));
            await createAndSendOffer();
        }        
        
        startCallTimer();
        
    } catch (error) {
        console.error('Error initializing WebRTC:', error);
        showToast('Failed to access microphone. Please check permissions.', 'error');
        resetToSetup();
    }
}

async function createAndSendOffer() {
    console.log("this is running offer is created ", peerConnection, roomId, userId, socket);
    if (!peerConnection || !roomId || !userId || !socket) return;
    
    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        socket.timeout(2000).emit(
            "webrtc_offer",
            { roomId, from: userId, offer: offer },
            (err, res) => {
              if (err || !res.ok) {
                if(err.reason==='ROOM_NOT_FOUND'){
                  showToast('Room not found', 'error');
                  resetToStart();
                  return;
                }
                console.log("Offer failed");
                // dissolve UI / retry
                return;
              }
              console.log("Offer recieved at server");
              // continue WebRTC
            }
          );
    } catch (error) {
        console.error('Error creating offer:', error);
    }
}

async function handleWebRTCOffer(offer, ack) {
    if (!peerConnection || callRole !== 'callee' || !socket) {
        // if (socket) socket.emit("error");
        if(ack) ack({ok:false});
        return;
    }
    
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        remoteDescriptionSet = true;
        //  yha server ko notify kr diya that tera offer mujhe mil gyaa no problem now you can relax;
        if(ack) ack({ok:true});
        for (const candidate of pendingIceCandidates) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
        pendingIceCandidates = [];
        
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        socket.timeout(2000).emit('webrtc_answer', {
            roomId,
            from: userId,
            answer: answer,
          }, (err, response) => {
            if (err) {
              console.error("webrtc_answer ACK timeout or error", err);
              socket.emit("error");
              return;
            }
            if(response.ok){
              // sendToUser(userId, { type:"webrtc_answer_ok", message:"Answer delivered" });
              socket.emit("message", JSON.stringify({type:"webrtc_answer_ok"}));
            } else {
              // sendToUser(userId, { type:"error", message:"Error handling answer" });
              socket.emit("error");
            }
          });
          if(ack) ack({ok:true});    
    } catch (error) {
        console.error('Error handling offer:', error);
        if(ack) ack({ok:false});
    }
}

async function handleWebRTCAnswer(answer, ack) {
    if (!peerConnection || callRole !== 'caller' || !socket) {
        // if (socket) socket.emit("error");
        if(ack) ack({ok:false});
        return;
    }
    
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        remoteDescriptionSet = true;
        if(ack) ack({ok:true});
        
        for (const candidate of pendingIceCandidates) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
        pendingIceCandidates = [];
    } catch (error) {
        console.error('Error handling answer:', error);
        if (socket) socket.emit("error");
    }
}

function showSetupPage() {
    if (setupPage) setupPage.style.display = 'flex';
    if (callPage) callPage.classList.remove('active');
    if (floatingCallWindow) {
        floatingCallWindow.classList.remove('active');
        floatingCallWindow.classList.remove('minimized');
        floatingCallWindow.classList.remove('waiting-state');
    }
    
    isFloatingMinimized = false;
    isWaitingForMatch = false;
    
    // Stop timers
    stopSearchTimer();
    if (callTimerInterval) {
        clearInterval(callTimerInterval);
        callTimerInterval = null;
    }
}

function showCallScreen() {
    if (setupPage) setupPage.style.display = 'none';
    if (callPage) callPage.classList.add('active');
    if (floatingCallWindow) {
        floatingCallWindow.classList.remove('active');
        floatingCallWindow.classList.remove('minimized');
    }
    
    isFloatingMinimized = false;
    
    // Update floating window status to "Connected"
    const floatingPartnerCountry = document.getElementById('floatingPartnerCountry');
    if (floatingPartnerCountry) floatingPartnerCountry.textContent = 'Connected';
    
    // Set initial speaker button state (loudMode is false initially)
    const speakerBtn = document.getElementById('speakerBtn');
    if (speakerBtn) {
        speakerBtn.innerHTML = '<i class="fas fa-volume-down"></i>';
    }
    
    // Set initial audio volume
    const remoteAudio = document.getElementById('remoteAudio');
    if (remoteAudio) {
        remoteAudio.volume = 0.11; // Normal mode volume (loudMode is false)
    }
}

function showWaitingForMatch() {
    // Clear existing waiting UI from video container if any
    const videoContainer = document.querySelector('.video-container');
    if (videoContainer) {
        const existingWaiting = videoContainer.querySelector('.waiting-container');
        if (existingWaiting) existingWaiting.remove();
    }
    
    if (callPage) callPage.classList.remove('active');
    if (setupPage) setupPage.style.display = 'none';
    
    // Replace floating window content with hello.html UI
    if (floatingCallWindow) {
        // Reset inline styles that might interfere with centering
        floatingCallWindow.style.left = '';
        floatingCallWindow.style.top = '';
        floatingCallWindow.style.right = '';
        floatingCallWindow.style.bottom = '';
        floatingCallWindow.style.transform = '';
        floatingCallWindow.style.cursor = '';
        
        floatingCallWindow.classList.add('active', 'waiting-state');
        floatingCallWindow.innerHTML = `
            <div class="waiting-card-content">
                <!-- Logo -->
                <div class="waiting-logo">
                    <div class="waiting-logo-icon">
                        <i class="fas fa-random"></i>
                    </div>
                    <div class="waiting-logo-text">RandomCall</div>
                </div>
                
                <!-- Animation -->
                <div class="waiting-animation-container">
                    <div class="waiting-main-circle">
                        <i class="fas fa-user-friends"></i>
                    </div>
                    
                    <!-- Orbiting circles -->
                    <div class="waiting-orbit">
                        <div class="waiting-orbiting-circle"></div>
                        <div class="waiting-orbiting-circle"></div>
                        <div class="waiting-orbiting-circle"></div>
                        <div class="waiting-orbiting-circle"></div>
                    </div>
                    
                    <!-- Pulse rings -->
                    <div class="waiting-pulse-ring"></div>
                    <div class="waiting-pulse-ring"></div>
                    <div class="waiting-pulse-ring"></div>
                </div>
                
                <!-- Text Content -->
                <h1 class="waiting-title">Finding a Partner</h1>
                
                <!-- Loading dots -->
                <div class="waiting-loading-dots">
                    <div class="waiting-dot"></div>
                    <div class="waiting-dot"></div>
                    <div class="waiting-dot"></div>
                </div>
                
                <!-- Stats -->
                <div class="waiting-stats-container">
                    <div class="waiting-stat">
                        <div class="waiting-stat-number" id="waiting-search-time">0s</div>
                        <div class="waiting-stat-label">Search Time</div>
                    </div>
                    <div class="waiting-stat">
                        <div class="waiting-stat-number" id="waiting-users-online">1,247</div>
                        <div class="waiting-stat-label">Users Online</div>
                    </div>
                    <div class="waiting-stat">
                        <div class="waiting-stat-number" id="waiting-match-score">80%</div>
                        <div class="waiting-stat-label">Match Quality</div>
                    </div>
                </div>
                
                <!-- Cancel Button -->
                <button class="waiting-cancel-btn" id="waitingCancelBtn">
                    <i class="fas fa-times-circle"></i>
                    Cancel Search
                </button>
                
                <!-- Footer Tip -->
                <div class="waiting-footer-tip">
                    <i class="fas fa-lightbulb"></i>
                    <span>Tip: You'll be connected with a random partner from anywhere in the world</span>
                </div>
            </div>
        `;
        
        // Setup cancel button
        const cancelBtn = floatingCallWindow.querySelector('#waitingCancelBtn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                endCall();
            });
        }
        
        // Start search time tracking
        startSearchTimer();
    }
    
    isWaitingForMatch = true;

    if (nonHumanMatch) nonHumanMatch = false;
    waitingTimer = Date.now();
    console.log("show waiting retry");
    startWaitingRetry();
}

function restoreFloatingWindowHTML() {
    if (!floatingCallWindow) return;
    
    floatingCallWindow.innerHTML = `
        <div class="floating-header" id="floatingHeader">
            <h3><i class="fas fa-phone-alt"></i> Call</h3>
            <div style="display: flex; align-items: center; gap: 8px;">
                <div class="floating-timer" id="floatingTimer">00:00</div>
                <button class="floating-minimize-btn" id="minimizeFloatingBtn" title="Minimize">
                    <i class="fas fa-chevron-down"></i>
                </button>
            </div>
        </div>
        
        <div class="floating-body">
            <div class="floating-video-placeholder">
                <i class="fas fa-user-circle"></i>
            </div>
            <div class="floating-user-info">
                <h4 id="floatingPartnerName">Stranger</h4>
                <p id="floatingConnectionStatus"><span class="flag">🌎</span> <span id="floatingPartnerCountry">Connected</span></p>
            </div>
        </div>
        
        <div class="floating-controls">
            <button class="floating-control-btn" id="floatingMuteBtn" title="Mute">
                <i class="fas fa-microphone"></i>
            </button>
            <button class="floating-control-btn end" id="floatingEndBtn" title="End Call">
                <i class="fas fa-phone-slash"></i>
            </button>
            <button class="floating-control-btn" id="floatingSkipBtn" title="Skip">
                <i class="fas fa-forward"></i>
            </button>
        </div>
    `;
    
    // Re-setup event listeners for floating window controls
    const floatingMuteBtn = document.getElementById('floatingMuteBtn');
    const floatingEndBtn = document.getElementById('floatingEndBtn');
    const floatingSkipBtn = document.getElementById('floatingSkipBtn');
    const minimizeFloatingBtn = document.getElementById('minimizeFloatingBtn');
    
    if (floatingMuteBtn) floatingMuteBtn.addEventListener('click', toggleMute);
    if (floatingEndBtn) floatingEndBtn.addEventListener('click', endCall);
    if (floatingSkipBtn) floatingSkipBtn.addEventListener('click', skipConversation);
    
    if (minimizeFloatingBtn) {
        minimizeFloatingBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFloatingMinimize();
        });
    }
    
    setupFloatingWindowDrag();
}

function hideWaitingMessage() {
    const videoContainer = document.querySelector('.video-container');
    if (videoContainer) {
        const waitingMessage = videoContainer.querySelector('.waiting-container');
        if (waitingMessage) waitingMessage.remove();
    }
    
    // Remove waiting state from floating window and restore original HTML
    if (floatingCallWindow) {
        floatingCallWindow.classList.remove('waiting-state');
        // Restore the original floating window HTML structure
        restoreFloatingWindowHTML();
    }
    
    // Stop search timer
    stopSearchTimer();
    
    if (!nonHumanMatch) stopWaitingRetry();
}

function startSearchTimer() {
    searchTimeSeconds = 0;
    stopSearchTimer(); // Clear any existing timer
    
    const searchTimeElement = document.getElementById('waiting-search-time');
    const matchScoreElement = document.getElementById('waiting-match-score');
    const usersOnlineElement = document.getElementById('waiting-users-online');
    
    if (!searchTimeElement) return;
    
    // Update online count from onlineCountElement if available
    if (onlineCountElement && usersOnlineElement) {
        const onlineText = onlineCountElement.textContent || '190 online';
        const countMatch = onlineText.match(/([\d,]+)/);
        if (countMatch) {
            usersOnlineElement.textContent = countMatch[1];
        } else {
            // Fallback: try to get the count directly if format is different
            const fallbackCount = onlineText.replace(/[^\d]/g, '');
            if (fallbackCount) {
                usersOnlineElement.textContent = parseInt(fallbackCount).toLocaleString();
            }
        }
    }
    
    searchTimeInterval = setInterval(() => {
        searchTimeSeconds++;
        if (searchTimeElement) {
            searchTimeElement.textContent = searchTimeSeconds + 's';
        }
        
        // Update match quality (improves over time, max 95%)
        if (matchScoreElement && searchTimeSeconds <= 30) {
            const matchScore = 80 + Math.min(searchTimeSeconds * 0.5, 15);
            matchScoreElement.textContent = Math.round(matchScore) + '%';
        }
        
        // Update online users from onlineCountElement if available (real-time updates)
        if (onlineCountElement && usersOnlineElement) {
            const onlineText = onlineCountElement.textContent || '';
            const countMatch = onlineText.match(/([\d,]+)/);
            if (countMatch) {
                usersOnlineElement.textContent = countMatch[1];
            }
        }
    }, 1000);
}

function stopSearchTimer() {
    if (searchTimeInterval) {
        clearInterval(searchTimeInterval);
        searchTimeInterval = null;
    }
    searchTimeSeconds = 0;
}

function startCallTimer() {
    callSeconds = 0;
    updateCallTimerDisplay();
    
    if (callTimerInterval) clearInterval(callTimerInterval);
    callTimerInterval = setInterval(() => {
        callSeconds++;
        updateCallTimerDisplay();
    }, 1000);
}

function stopCallTimer(){
    // Reset call timer and display
    callSeconds = 0;
    if (callTimerInterval) {
        clearInterval(callTimerInterval);
        callTimerInterval = null;
    }
    // Update timer displays to 00:00
    const callTimerElement = document.getElementById('callTimer');
    const floatingTimerElement = document.getElementById('floatingTimer');
    if (callTimerElement) callTimerElement.textContent = '00:00';
    if (floatingTimerElement) floatingTimerElement.textContent = '00:00';
}

function updateCallTimerDisplay() {
    const minutes = Math.floor(callSeconds / 60).toString().padStart(2, '0');
    const seconds = (callSeconds % 60).toString().padStart(2, '0');
    const timeString = `${minutes}:${seconds}`;
    
    const callTimerElement = document.getElementById('callTimer');
    const floatingTimerElement = document.getElementById('floatingTimer');
    
    if (callTimerElement) callTimerElement.textContent = timeString;
    if (floatingTimerElement) floatingTimerElement.textContent = timeString;
}

function requestPartnerInfo() {
    if (!socket || !roomId || !userId) return;
    
    socket.emit('message', JSON.stringify({
        type: 'get_partner_info',
        roomId,
        userId
    }));
}

function sendJoinToRoomEvent(payload) {
    if (!socket) return;
    socket.timeout(5000).emit('join', payload, (err, res) => {
        if (res?.ok) {
            showToast('WAITING', 'info');
        } else {
            if (res?.reason === 'MISSING_USERID') {
                showToast('Error!!!', 'error');
                resetToSetup();
            } else if (res?.reason === 'BANNED') {
                showToast('BANNED', 'info');
                resetToSetup();
            } else if (res?.reason === 'ERROR') {
                showToast('ERROR', 'error');
            }
        }
        if (err) {
            showToast('JOIN TIMEOUT', 'error');
            return;
        }
    });
}

function safeSendWithAck(socket, eventName, data) {
    try { 
        console.log(eventName, "client se event pr ", data);
        let retry = 0;
        const retryAttempt = async () => {
          console.log("function chala");
          retry++;
        
          socket
            .timeout(2000)
            .emit(eventName, data, async (err, res) => {
        
              // ✅ Case 1: ACK received successfully
              if (!err && res?.ok) {
                const roomStateRaw = await redis.get(`room_state:${roomId}`);
                if (!roomStateRaw) return;
        
                const roomStateData = JSON.parse(roomStateRaw);
        
                // Idempotent update
                if (eventName==="webrtc_offer" && roomStateData.state !== room_state.OFFER_RECEIVED) {
                  await redis.set(
                    `room_state:${roomId}`,
                    JSON.stringify({
                      ...roomStateData,
                      state: room_state.OFFER_RECEIVED,
                      offerReceivedAt: Date.now()
                    })
                  );
                }
                else if(roomStateData.state !== room_state.ANSWER_RECEIVED){
                  await redis.set(
                    `room_state:${roomId}`,
                    JSON.stringify({
                      ...roomStateData,
                      state: room_state.ANSWER_RECEIVED,
                      answerReceivedAt:Date.now()
                    })
                  );
                }
                return; // ✅ STOP retries
              }
        
              // ❌ Case 2: Timeout or bad response
              if (retry >= MAX_RETRY) {
                cleanup();
                return;
              }
        
              // ✅ Controlled retry (no recursion)
              setTimeout(retryAttempt, RETRY_DELAY);
            });
            console.log("event emit hua");
        };
        
        // initial call
        retryAttempt();
    } catch (e) { /* ignore */ }
  }

function endCall() {

    if(nonHumanMatch) stopBotVoice();
    // If user is waiting for a match, notify server to reset start state
    if (isWaitingForMatch && socket && userId) {
        try { socket.emit('reset_start', { userId, want: 'call' }); } catch(e) {}
    }

    if (socket && roomId && userId) {
        socket.emit('leave', {
            roomId,
            userId,
            want: 'call',
            gender: localStorage.getItem('selfGender') || 'any',
            preference: localStorage.getItem('callPreference') || 'any',
            interests: []
        });
    }
    
    handleCallDisconnection('user_ended');
    resetToSetup();
}

function skipConversation() {

    if(nonHumanMatch) stopBotVoice();
    // If user is waiting for a match, notify server to reset start state

    if (socket && roomId && userId) {
        socket.emit('skip', {
            roomId,
            userId,
            want: 'call',
            gender: localStorage.getItem('selfGender') || 'any',
            preference: localStorage.getItem('callPreference') || 'any',
            username:localStorage.getItem("username"),
            interests: []
        });
    }
    
    handleCallDisconnection('skipped');
}

function toggleMute() {
    if (!localStream) return;
    
    const audioTracks = localStream.getAudioTracks();
    if (audioTracks.length === 0) return;
    
    isMuted = !isMuted;
    audioTracks.forEach(track => {
        track.enabled = !isMuted;
    });
    
    const muteBtn = document.getElementById('muteBtn');
    const floatingMuteBtn = document.getElementById('floatingMuteBtn');
    
    if (muteBtn) {
        muteBtn.innerHTML = isMuted ? '<i class="fas fa-microphone-slash"></i>' : '<i class="fas fa-microphone"></i>';
    }
    
    if (floatingMuteBtn) {
        floatingMuteBtn.innerHTML = isMuted ? '<i class="fas fa-microphone-slash"></i>' : '<i class="fas fa-microphone"></i>';
        if (isMuted) floatingMuteBtn.classList.add('muted');
        else floatingMuteBtn.classList.remove('muted');
    }
    
    showToast(isMuted ? 'Microphone muted' : 'Microphone unmuted', isMuted ? 'info' : 'success');
    // notify partner that this user muted/unmuted
    try {
        if (socket && roomId && userId) {
            socket.emit('message', JSON.stringify({
                type: 'peer_muted',
                roomId,
                userId: userId || localStorage.getItem("userId"),
                muted: isMuted
            }));
        }
    } catch (e) {
        console.warn('mute notify failed', e);
    }
}

function toggleSpeaker() {
    const remoteAudio = document.getElementById('remoteAudio');
    if (!remoteAudio) return;
    
    loudMode = !loudMode;
    remoteAudio.volume = loudMode ? 1.0 : 0.11;
    
    const speakerBtn = document.getElementById('speakerBtn');
    if (speakerBtn) {
        if (loudMode) {
            speakerBtn.innerHTML = '<i class="fas fa-volume-up"></i>';
            showToast('Loud mode enabled', 'success');
        } else {
            speakerBtn.innerHTML = '<i class="fas fa-volume-down"></i>';
            showToast('Normal mode enabled', 'info');
        }
    }
}

function minimizeToFloating() {
    if (callPage && callPage.classList.contains('active')) {
        callPage.classList.remove('active');
        if (floatingCallWindow) {
            floatingCallWindow.classList.add('active');
            floatingCallWindow.classList.remove('minimized');
            isFloatingMinimized = false;
            // Allow floating window to be minimized again when user explicitly
            // minimizes from the main call view.
            disableMinimizeFromFloating = false;
            const minBtn = document.querySelector('#minimizeFloatingBtn');
            if (minBtn) {
                minBtn.innerHTML = '<i class="fas fa-chevron-down"></i>';
                minBtn.title = 'Minimize';
            }
        }
    }
}

function toggleFloatingMinimize() {
    if (!floatingCallWindow) return;
    // If minimizing from floating window is disabled, ignore attempts to minimize
    if (!isFloatingMinimized && disableMinimizeFromFloating) return;

    isFloatingMinimized = !isFloatingMinimized;
    if (isFloatingMinimized) {
        floatingCallWindow.classList.add('minimized');
        const rect = floatingCallWindow.getBoundingClientRect();
        floatingWindowPos.x = rect.left;
        floatingWindowPos.y = rect.top;
        // update minimize button to indicate maximize
        const minBtn = document.querySelector('#minimizeFloatingBtn');
        if (minBtn) {
            minBtn.innerHTML = '<i class="fas fa-chevron-up"></i>';
            minBtn.title = 'Maximize';
        }
    } else {
        // When restoring from minimized, show the call page
        if (isCallActive && callPage) {
            showCallScreen();
        } else {
            // If not in active call, just restore the floating window
            floatingCallWindow.classList.remove('minimized');
            const minBtn = document.querySelector('#minimizeFloatingBtn');
            if (minBtn) {
                minBtn.innerHTML = '<i class="fas fa-chevron-down"></i>';
                minBtn.title = 'Minimize';
            }
        }
    }
}

function handleCallDisconnection(reason) {
    showToast(reason, 'info');
    remoteDescriptionSet = false;
    
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    if (remoteStream) {
        remoteStream = null;
    }
    
    const remoteAudio = document.getElementById('remoteAudio');
    if (remoteAudio) {
        remoteAudio.srcObject = null;
        remoteAudio.remove();
    }
    
    isMuted = false;
    loudMode = false;
    isFloatingMinimized = false;
    
    localStorage.removeItem('roomId');
    stopCallTimer();
}

function resetToSetup() {
    roomId = null;
    partnerId = null;
    callRole = null;
    partnerData = null;
    isCallActive = false;
    isWaitingForMatch = false;
    stopWaitingRetry();
    showSetupPage();
}

function resetToWaiting(type='not_skipped') {
    roomId = null;
    partnerId = null;
    callRole = null;
    partnerData = null;
    isCallActive = false;
    
    if (type==='not_skipped' && socket && userId) {
        const username = localStorage.getItem('username') || 'Stranger';
        const selectedGender = localStorage.getItem('selfGender') || 'male';
        const selectedPartnerGender = localStorage.getItem('callPreference') || 'any';
        
        sendJoinToRoomEvent({
            userId: userId,
            want: 'call',
            username: username,
            gender: selectedGender,
            preference: selectedPartnerGender,
            interests: []
        });
    }
    
    showWaitingForMatch();
}

function setupFloatingWindowDrag() {
    const floatingHeader = document.getElementById('floatingHeader');
    if (!floatingHeader || !floatingCallWindow) return;
    
    floatingHeader.addEventListener('mousedown', startDrag);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', stopDrag);
    
    floatingHeader.addEventListener('touchstart', startDragTouch);
    document.addEventListener('touchmove', dragTouch);
    document.addEventListener('touchend', stopDrag);
    
    floatingCallWindow.addEventListener('click', (e) => {
        if (isFloatingMinimized && !e.target.closest('.floating-minimize-btn')) {
            floatingCallWindow.classList.remove('minimized');
            isFloatingMinimized = false;
        }
    });
}

function startDrag(e) {
    // Don't drag if clicking the minimize button
    if (e.target.closest('.floating-minimize-btn')) return;
    if (isFloatingMinimized) return;
    
    isDragging = true;
    const rect = floatingCallWindow.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    floatingCallWindow.style.cursor = 'grabbing';
    floatingCallWindow.style.transition = 'none';
    e.preventDefault();
}

function startDragTouch(e) {
    // Don't start dragging if touching the minimize button on touch devices
    if (e.target && e.target.closest && e.target.closest('.floating-minimize-btn')) return;
    if (isFloatingMinimized) return;
    
    isDragging = true;
    const touch = e.touches[0];
    const rect = floatingCallWindow.getBoundingClientRect();
    dragOffsetX = touch.clientX - rect.left;
    dragOffsetY = touch.clientY - rect.top;
    floatingCallWindow.style.transition = 'none';
    e.preventDefault();
}

function drag(e) {
    if (!isDragging) return;
    
    let x = e.clientX - dragOffsetX;
    let y = e.clientY - dragOffsetY;
    
    const headerHeight = 70;
    const marginFromHeader = 20;
    const minY = headerHeight + marginFromHeader;
    const maxX = window.innerWidth - floatingCallWindow.offsetWidth;
    const maxY = window.innerHeight - floatingCallWindow.offsetHeight;
    
    x = Math.max(0, Math.min(x, maxX));
    y = Math.max(minY, Math.min(y, maxY));
    
    floatingCallWindow.style.left = `${x}px`;
    floatingCallWindow.style.top = `${y}px`;
    floatingCallWindow.style.right = 'auto';
    
    floatingWindowPos.x = x;
    floatingWindowPos.y = y;
}

function dragTouch(e) {
    if (!isDragging) return;
    
    const touch = e.touches[0];
    let x = touch.clientX - dragOffsetX;
    let y = touch.clientY - dragOffsetY;
    
    const headerHeight = 70;
    const marginFromHeader = 20;
    const minY = headerHeight + marginFromHeader;
    const maxX = window.innerWidth - floatingCallWindow.offsetWidth;
    const maxY = window.innerHeight - floatingCallWindow.offsetHeight;
    
    x = Math.max(0, Math.min(x, maxX));
    y = Math.max(minY, Math.min(y, maxY));
    
    floatingCallWindow.style.left = `${x}px`;
    floatingCallWindow.style.top = `${y}px`;
    floatingCallWindow.style.right = 'auto';
    
    floatingWindowPos.x = x;
    floatingWindowPos.y = y;
}

function stopDrag() {
    isDragging = false;
    if (floatingCallWindow) {
        floatingCallWindow.style.cursor = 'grab';
        floatingCallWindow.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
    }
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(initCall, 100);
    });
} else {
    setTimeout(initCall, 100);
}

// handle mute notifications from partner
function handlePeerMuted(msg) {
    if (!msg) return;
    const muted = !!msg.muted;
    if (muted) showToast('Partner muted their mic', 'info');
    else showToast('Partner unmuted their mic', 'info');
}