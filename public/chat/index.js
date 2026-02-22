// public/chat/index.js
// Chat-specific functionality

import { getSocket, getUserId, setUserId, getInstanceId, setInstanceId } from '/app.js';
import { showToast, navigateToPage } from '/utils.js';

// Chat state
let socket = null;
let userId = null;
let instanceId = null;
let roomId = null;
let partnerId = null;
let currentWant = 'chat';
let selectedChatWith = localStorage.getItem('chatPreference') || 'male';
let selectedGender = localStorage.getItem('selfGender') || 'male';
let selectedInterests = [];
try {
  const stored = localStorage.getItem('interests');
  if (stored) selectedInterests = JSON.parse(stored);
} catch (_) {}

let retryTimer = null;
let waitingTimer = null;
let nonHumanMatch = false;
if(localStorage.getItem("nonHumanMatch")){
  nonHumanMatch = localStorage.getItem("nonHumanMatch");
}
else localStorage.setItem("nonHumanMatch", "false");
const pendingMessages = new Map();
let typingSent = false;
let typingStopTimer = null;
let prePC = null;
let preGatherTimer = null;


// Initialize chat module
export function initChat() {
  socket = getSocket();
  userId = getUserId();
  instanceId = getInstanceId();
  
  if (!socket || !socket.connected) {
    console.warn('Socket not connected, waiting...');
    setTimeout(() => initChat(), 1000);
    return;
  }

  setupMessageHandlers();
  wireUI();
  navigateToPage(1);
}

function setupMessageHandlers() {
  socket.on('message', (msg) => {
    console.log("message is ", msg);
    msg = JSON.parse(msg);
    handleMsg(msg);
  });
}

function handleMsg(msg) {
  if (msg.type === 'auth_ok') {
    userId = msg.userId;
    // localStorage.setItem("userId", userId);
    instanceId = msg.instance;
    setUserId(userId);
    console.log("userId is ", userId, localStorage.getItem("userId"));
    setInstanceId(instanceId);
    console.log('got userId', userId);
    return;
  }

  if (msg.type === 'resume_ok') {
    clearChatArea();
    userId = msg.userId;
    instanceId = msg.instance || instanceId;
    setUserId(userId);
    if (instanceId) setInstanceId(instanceId);
    console.log('resumed as', userId, 'room', msg.roomId);
    if (msg.roomId) {
      console.log("resume ho rha hain");
      resumeChats(msg);
      return;
    }
    return;
  }

  if (msg.type === 'resume_failed') {
    console.log('resume failed, doing fresh auth', msg.reason);
    socket.emit('message', JSON.stringify({ type:"auth", userId:getUserId() }));
    return;
  }

  if (msg.type === 'waiting') {
    console.log('waiting in queue', msg.queue);
    showChatInterface();
    showWaitingMessage();
    return;
  }

  if (msg.type === 'error') {
    showToast("Error", 'info');
    resetToStart();
    // sendJoinToRoomEvent({
    //   userId: getUserId(),
    //   want: 'chat',
    //   gender: selectedGender || 'any',
    //   preference: selectedChatWith || 'any',
    //   interests: selectedInterests
    // });
    // showChatInterface();
    // showWaitingMessage();
    // disableInputIfMatched();
  }

  if (msg.type === 'matched') {
    roomId = msg.roomId;
    partnerId = msg.partnerId;
    currentWant = msg.want || 'chat';
    // nonHumanMatch = false;
    localStorage.setItem("nonHumanMatch", "false");
    
    if (roomId) localStorage.setItem('roomId', roomId);
    
    const chatArea = document.getElementById('chatArea');
    if (!chatArea) return;
    stopWaitingRetry();
    hideWaitingMessage();
    showChatInterface();
    chatArea.innerHTML = '';
    enableInputIfMatched();
    updateFloatingControlsForChat();
    addMessage('You have been matched! Start chatting...', 'system');
    // pregatherAndSendPreoffer();
    return;
  }

  if (msg.type === 'matched_bot') {
    roomId = msg.roomId;
    const chatArea = document.getElementById('chatArea');
    if (!chatArea) return;
    chatArea.innerHTML = '';
    // nonHumanMatch = true;
    localStorage.setItem("nonHumanMatch", "true");
    hideWaitingMessage();
    showChatInterface();
    enableInputIfMatched();
    updateFloatingControlsForChat();
    addMessage('You have been matched! Start chatting...', 'system');
    return;
  }

  if (msg.type === 'non_human_chat_end') {
    nonHumanMatch = localStorage.getItem("nonHumanMatch");
    // isko hatana hain
    if(nonHumanMatch==='false') return;
    sendJoinToRoomEvent({
      userId: getUserId(),
      want: 'chat',
      gender: selectedGender || 'any',
      preference: selectedChatWith || 'any',
      interests: selectedInterests
    });
    showChatInterface();
    showWaitingMessage();
    disableInputIfMatched();
    showToast("partner left", "info");
    return;
  }

  if (msg.type === 'text') {
    hidePartnerTyping();
    addMessage(msg.body, 'received');
    return;
  }

  if (msg.type === 'text_ack') {
    const seq = msg.seq;
    const el = pendingMessages.get(seq);
    if (el) {
      const statusEl = el.querySelector('.message-status');
      if (statusEl) {
        statusEl.innerHTML = '<i class="fas fa-check-double"></i>';
      }
      pendingMessages.delete(seq);
    } else {
      const lastStatus = document.querySelector('#chatArea .message.sent:last-child .message-status');
      if (lastStatus) {
        lastStatus.innerHTML = '<i class="fas fa-check-double"></i>';
      }
    }
    return;
  }

  if (msg.type === 'typing') {
    if (msg.from && msg.from !== userId) {
      if (msg.state) {
        showPartnerTyping();
      } else {
        hidePartnerTyping();
      }
    }
    return;
  }

  if (msg.type === 'preoffer') {
    if (!prePC) {
      prePC = new RTCPeerConnection();
      prePC.onicecandidate = () => {};
    }
    handleIncomingPreoffer(msg.localDesc);
    return;
  }

  if (msg.type === 'partner_left') {
    roomId = null;
    partnerId = null;
    sendJoinToRoomEvent({
      userId,
      want: currentWant,
      gender: localStorage.getItem('selfGender') || 'any',
      preference: localStorage.getItem('chatPreference') || 'any',
      interests: selectedInterests
    });
    showWaitingMessage();
    return;
  }

  if (msg.type === 'room_exist') {
    clearChatArea();
    // userId = msg.userId;
    instanceId = msg.instance || instanceId;
    // setUserId(userId);
    if (instanceId) setInstanceId(instanceId);
    console.log('resumed as', userId, 'room', msg.roomId);
    if (msg.roomId) {
      console.log("resume ho rha hain");
      resumeChats(msg);
      return;
    }
    return;
  }

  if (msg.type === 'interest_updated_ok') {
    showToast("Interest Updated", 'success');
  }

  if (msg.type === 'room_closed') {
    if (msg.reason === 'being_reported') showToast("Partner Reported and Room Left", "info");
    sendJoinToRoomEvent({
      userId: getUserId(),
      want: localStorage.getItem("want"),
      gender: selectedGender || 'any',
      preference: selectedChatWith || 'any',
      interests: selectedInterests
    });
    showWaitingMessage();
  }

  if (msg.type === 'skipped') {
    showWaitingMessage();
    return;
  }

  if (msg.type === 'report_ok') {
    showToast("Reported Successfully", 'info');
    return;
  }

  if (msg.type === 'banned') {
    const hours = msg.durationHours;
    const extra = hours ? ` for ${hours} hour${hours > 1 ? 's' : ''}` : '';
    addMessage(`You have been temporarily blocked${extra} due to multiple reports.`, 'system');
    return;
  }
}

// WebRTC pre-offer functions
async function handleIncomingPreoffer(remoteDesc) {
  if (!prePC) {
    prePC = new RTCPeerConnection();
    prePC.onicecandidate = () => {};
  }
  try {
    await prePC.setRemoteDescription(remoteDesc);
    const answer = await prePC.createAnswer();
    await prePC.setLocalDescription(answer);
    await new Promise(res => setTimeout(res, 300));
    socket.emit('message', JSON.stringify({
      type:"preoffer",
      roomId,
      from: userId,
      localDesc: prePC.localDescription,
    }));
    if (preGatherTimer) clearTimeout(preGatherTimer);
    preGatherTimer = setTimeout(() => {
      try { prePC.close(); } catch (_) {} 
      prePC = null;
    }, 90_000);
  } catch (e) {
    console.warn('handleIncomingPreoffer error', e);
  }
}

async function pregatherAndSendPreoffer() {
  if (!roomId || !userId) return;
  try {
    prePC = new RTCPeerConnection();
    prePC.onicecandidate = () => {};
    try { prePC.createDataChannel('pre'); } catch (_) {}
    const offer = await prePC.createOffer();
    await prePC.setLocalDescription(offer);
    await new Promise(res => {
      let done = false;
      const timeout = setTimeout(() => { if (!done) { done = true; res(); } }, 800);
      prePC.onicegatheringstatechange = () => {
        if (prePC.iceGatheringState === 'complete' && !done) {
          done = true;
          clearTimeout(timeout);
          res();
        }
      };
    });
    socket.emit('message', JSON.stringify({
      type:"preoffer",
      roomId,
      from: userId,
      localDesc: prePC.localDescription,
    }));
    if (preGatherTimer) clearTimeout(preGatherTimer);
    preGatherTimer = setTimeout(() => {
      try { prePC.close(); } catch (_) {}
      prePC = null;
    }, 90_000);
  } catch (e) {
    console.warn('pregather failed', e);
  }
}

// Floating controls
export function updateFloatingControlsForChat() {
  const muteBtn = document.getElementById('floatingMuteBtn');
  const endBtn = document.getElementById('floatingEndBtn');
  const skipBtn = document.getElementById('floatingSkipBtn');
  
  if (muteBtn) muteBtn.style.display = 'none';
  if (endBtn) endBtn.style.display = 'none';
  if (skipBtn) {
    skipBtn.style.display = 'flex';
    skipBtn.innerHTML = '<i class="fas fa-forward"></i>';
    skipBtn.title = 'Skip Conversation';
    skipBtn.classList.remove('confirm');
  }
}

export function updateFloatingControlsForWaiting() {
  const muteBtn = document.getElementById('floatingMuteBtn');
  const endBtn = document.getElementById('floatingEndBtn');
  const skipBtn = document.getElementById('floatingSkipBtn');
  
  if (muteBtn) muteBtn.style.display = 'none';
  if (endBtn) endBtn.style.display = 'none';
  if (skipBtn) endBtn.style.display = 'none';
}

// Selection and age wiring
function wireSelectionAndAge() {
  const selectionCards = document.querySelectorAll('.selection-card');
  const ageCheck = document.getElementById('ageCheck');
  const nextButton1 = document.getElementById('nextButton1');

  function updateNextButton() {
    if (!nextButton1) return;
    const ageOk = ageCheck && ageCheck.checked;
    if (ageOk) {
      nextButton1.disabled = false;
      nextButton1.innerHTML = '<i class="fas fa-arrow-right"></i> Continue to Security';
    } else {
      nextButton1.disabled = true;
      nextButton1.innerHTML = '<i class="fas fa-lock"></i> Confirm Age to Continue';
    }
  }

  selectionCards.forEach(card => {
    card.addEventListener('click', () => {
      const group = card.closest('.selection-group');
      if (!group) return;
      const label = group.querySelector('.selection-label');
      const all = group.querySelectorAll('.selection-card');
      all.forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      const value = card.getAttribute('data-value') || 'all';
      if (label && label.textContent.includes('chat with')) {
        selectedChatWith = value;
        localStorage.setItem('chatPreference', selectedChatWith);
      } else if (label && label.textContent.includes('identify')) {
        selectedGender = value;
        localStorage.setItem('selfGender', selectedGender);
      }
      updateNextButton();
    });
  });

  if (ageCheck) ageCheck.addEventListener('change', updateNextButton);
  updateNextButton();

  if (nextButton1) {
    nextButton1.addEventListener('click', () => {
      if (!nextButton1.disabled) navigateToPage(2);
    });
  }

  const nextButton2 = document.getElementById('nextButton2');
  if (nextButton2) {
    nextButton2.addEventListener('click', () => {
      console.log("button is clicked ");
      localStorage.setItem("want", 'chat');
      console.log("button is clicked 1");
      currentWant = 'chat';
      console.log("userId is ", userId);
      if (!userId) {
        addMessage('Connecting to server, please wait a moment...', 'system');
        return;
      }
      console.log("button is clicked 3" );

      showChatInterface();
      console.log("button is clicked 4");

      sendJoinToRoomEvent({
        userId,
        want: 'chat',
        gender: selectedGender || 'any',
        preference: selectedChatWith || 'any',
        interests: selectedInterests
      });
      console.log("button is clicked 5");

      showWaitingMessage();
    });
  }
}

// Chat input wiring
function wireChatInput() {
  const sendButton = document.getElementById('sendButton');
  const messageInput = document.getElementById('messageInput');
  if (!sendButton || !messageInput) return;

  sendButton.addEventListener('click', () => {
    const v = messageInput.value.trim();
    if (!v) return;
    sendText(v);
    messageInput.value = '';
  });

  messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendButton.click();
    }
  });

  messageInput.addEventListener('input', () => {
    handleLocalTyping();
  });
}

function handleLocalTyping() {
  if (!roomId || !userId || !socket || !socket.connected) return;
  if (!typingSent) {
    sendTypingState(true);
    typingSent = true;
  }
  if (typingStopTimer) clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(() => {
    sendTypingState(false);
    typingSent = false;
    typingStopTimer = null;
  }, 1500);
}

function sendText(body) {
  if (!roomId || !userId) {
    if (!roomId) {
      addMessage('Please wait for a match before sending messages.', 'system');
    }
  } else {
    const seq = Date.now();
    socket.emit('message', JSON.stringify({type:"text", roomId, from: userId, body, seq }));
    const el = addMessage(body, 'sent');
    if (el) {
      pendingMessages.set(seq, el);
      el.dataset.seq = String(seq);
    }
  }
  if (typingSent && socket && socket.connected && roomId && userId) {
    socket.emit('message', JSON.stringify({type:"typing", roomId, from: userId, state: false }));
  }
  resetTypingState();
}

function sendTypingState(isTyping) {
  if (!roomId || !userId || !socket || !socket.connected) return;
  socket.emit('message', JSON.stringify({
    type:"typing",
    roomId,
    from: userId,
    state: isTyping,
  }));
}

function resetTypingState() {
  typingSent = false;
  if (typingStopTimer) {
    clearTimeout(typingStopTimer);
    typingStopTimer = null;
  }
  hidePartnerTyping();
}

function showChatInterface() {
  navigateToPage(3);
}

function enableInputIfMatched() {
  const messageInput = document.getElementById('messageInput');
  const sendButton = document.getElementById('sendButton');
  const disabled = !roomId;
  if (messageInput) messageInput.disabled = disabled;
  if (sendButton) sendButton.disabled = disabled;
}

function disableInputIfMatched() {
  const messageInput = document.getElementById('messageInput');
  const sendButton = document.getElementById('sendButton');
  if (messageInput) {
    messageInput.value = '';
    messageInput.disabled = true;
  }
  if (sendButton) sendButton.disabled = true;
}

function showWaitingMessage() {
  const chatArea = document.getElementById('chatArea');
  if (!chatArea) return;
  chatArea.innerHTML = '';
  const waitingDiv = document.createElement('div');
  waitingDiv.id = 'waitingMessage';
  waitingDiv.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;text-align:center;padding:20px;';
  waitingDiv.innerHTML = `
    <div style="font-size:3rem;margin-bottom:20px;animation:bounce 2s infinite;">
      <i class="fas fa-search"></i>
    </div>
    <h2 style="color:var(--primary);margin-bottom:10px;font-size:1.5rem;">Looking for a ${currentWant} partner...</h2>
    <p style="color:var(--text-light);font-size:1rem;max-width:300px;">Please wait while we find someone to chat with you.</p>
    <div class="loading-dots" style="margin-top:20px;">
      <div class="dot"></div>
      <div class="dot"></div>
      <div class="dot"></div>
    </div>
  `;
  chatArea.appendChild(waitingDiv);
  // nonHumanMatch = false;
  localStorage.setItem("nonHumanMatch", "false");
  waitingTimer = Date.now();
  startWaitingRetry();
  updateFloatingControlsForWaiting();
}

function hideWaitingMessage() {
  const waitingDiv = document.getElementById('waitingMessage');
  if (waitingDiv) waitingDiv.remove();
  // if (localStorage.getItem("nonHumanMatch")==='false') stopWaitingRetry();
}

function showPartnerTyping() {
  const chatArea = document.getElementById('chatArea');
  if (!chatArea) return;
  let typingDiv = document.getElementById('partnerTyping');
  if (!typingDiv) {
    typingDiv = document.createElement('div');
    typingDiv.id = 'partnerTyping';
    typingDiv.className = 'typing-indicator';
    typingDiv.innerHTML = `
      <span class="typing-text">typing</span>
      <div class="typing-dots">
        <span></span>
        <span></span>
        <span></span>
      </div>
    `;
    chatArea.appendChild(typingDiv);
  }
  chatArea.scrollTop = chatArea.scrollHeight;
}

function hidePartnerTyping() {
  const typingDiv = document.getElementById('partnerTyping');
  if (typingDiv) typingDiv.remove();
}

export function addMessage(text, type, timestamp) {
  const chatArea = document.getElementById('chatArea');
  if (!chatArea) return null;
  const messageElement = document.createElement('div');
  messageElement.classList.add('message', type);
  const time = timestamp ? new Date(timestamp) : new Date();
  const minutes = time.getMinutes();
  const timeString = time.getHours() + ':' + (minutes < 10 ? '0' + minutes : minutes);
  let statusHtml = '';
  if (type === 'sent') {
    statusHtml = '<div class="message-status"><i class="fas fa-check"></i></div>';
  }
  if (type === 'system') {
    messageElement.classList.add('system-message');
    messageElement.style.cssText = 'align-self: center; background-color: rgba(139, 92, 246, 0.1); color: var(--primary); padding: 8px 16px; border-radius: 15px; font-size: 0.9rem; margin: 10px 0;';
    messageElement.innerHTML = `
      ${text}
      <div class="message-info">
        <div class="message-time">${timeString}</div>
      </div>
    `;
  } else {
    messageElement.innerHTML = `
      ${text}
      <div class="message-info">
        <div class="message-time">${timeString}</div>
        ${statusHtml}
      </div>
    `;
  }
  chatArea.appendChild(messageElement);
  chatArea.scrollTop = chatArea.scrollHeight;
  return messageElement;
}

function resumeChats(msg) {
  roomId = msg.roomId;
  partnerId = msg.partnerId || null;
  showChatInterface();
  const chatArea = document.getElementById('chatArea');
  if (chatArea) {
    chatArea.innerHTML = '';
    if (msg.messages && msg.messages.length > 0) {
      msg.messages.forEach(m => {
        const type = m.from === userId ? 'sent' : 'received';
        addMessage(m.body, type, m.ts);
      });
    }
    // addMessage('You have been matched! Start chatting...', 'system');
  }
  enableInputIfMatched();
}

function clearChatArea() {
  const chatArea = document.getElementById("chatArea");
  if (!chatArea) return;
  chatArea.innerHTML = '';
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
    const preference = localStorage.getItem("chatPreference") || "any";
    console.log("waiting time(ms):", waitedMs, "want:", currentWant);
    nonHumanMatch = localStorage.getItem("nonHumanMatch")
    if (currentWant === "chat" && waitedMs > 10_000 && nonHumanMatch === 'false') {
      socket.emit("message", JSON.stringify({
        type:"non-human-chat",
        userId,
        gender: localStorage.getItem('selfGender') || 'any',
        preference: localStorage.getItem('chatPreference') || 'any',
        interests: selectedInterests
      }));
    } else {
      socket.emit("retry_match", {
        userId,
        want: currentWant,
        gender,
        preference,
        interests: selectedInterests
      }, (err, res) => { 
        if (err) {
          console.error("Retry match error:", err);
          return;
        }
        if (res && res.ok) {
          console.log("Retry match successful");
        } else if (res && res.reason) {
          console.log("Retry match failed:", res.reason);
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

function sendJoinToRoomEvent(payload) {
  socket.timeout(5000).emit("join", payload, (err, res) => {
    if (err) {
      showToast("JOIN TIMEOUT", "error");
      return;
    }
    if (res?.ok) {
      showToast("WAITING", "info");
    } else {
      if (res?.reason === "MISSING_USERID") {
        showToast("Error!!!", "error");
        resetToStart();
      } else if (res?.reason === "BANNED") {
        showToast("BANNED", "info");
        resetToStart();
      } else if (res?.reason === "ERROR") {
        showToast("ERROR", "error");
      }
    }
  });
}

function resetToStart() {
  roomId = null;
  partnerId = null;
  resetTypingState();
  stopWaitingRetry();
  setTimeout(() => {
    socket.emit('reset_start', {userId}, (err, res) => {
      if (res && res.type === 'RESET_START_ACK') {
        console.log('Reset start acknowledged');
      }
    });
  }, 2000);
  localStorage.removeItem('roomId');
  navigateToPage(1);
  const chatArea = document.getElementById('chatArea');
  if (chatArea) chatArea.innerHTML = '';
  const messageInput = document.getElementById('messageInput');
  const sendButton = document.getElementById('sendButton');
  if (messageInput) {
    messageInput.disabled = true;
    messageInput.value = '';
  }
  if (sendButton) sendButton.disabled = true;
  updateFloatingControlsForWaiting();
}

export function skipConversation() {
  if (roomId && userId && socket && socket.connected) {
    socket.emit('skip', {
      roomId,
      userId,
      want: currentWant,
      gender: localStorage.getItem('selfGender') || 'any',
      preference: localStorage.getItem('chatPreference') || 'any',
      interests: selectedInterests
    });
    roomId = null;
    partnerId = null;
    showWaitingMessage();
    resetTypingState();
    showToast('Skipping conversation...', 'info');
  } else {
    resetToStart();
  }
}

function wireMenuSheet() {
  const modal = document.getElementById('menuModal');
  const panel = document.getElementById('sheetPanel');
  const menuButton = document.getElementById('menuButton');
  const reportUserBtn = document.getElementById('reportUserBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const supportBtn = document.getElementById('supportBtn');
  const exitBtn = document.getElementById('exitBtn');

  if (!modal || !panel || !menuButton) return;

  function openSheet() {
    modal.style.display = 'flex';
    setTimeout(() => {
      panel.style.transform = 'translateY(0)';
    }, 10);
  }

  function closeSheet() {
    panel.style.transform = 'translateY(100%)';
    setTimeout(() => {
      modal.style.display = 'none';
    }, 300);
  }

  menuButton.addEventListener('click', () => {
    openSheet();
  });

  modal.addEventListener('click', (e) => {
    if (e.target.id === 'menuModal') {
      closeSheet();
    }
  });

  if (reportUserBtn) {
    reportUserBtn.addEventListener('click', () => {
      closeSheet();
      if (!roomId || !userId || !partnerId || !socket || !socket.connected) {
        addMessage('No active partner to report right now.', 'system');
        return;
      }
      socket.emit('report', {
        userId,
        targetId: partnerId,
        roomId,
        reason: 'user_clicked_report',
      }, (err, res) => {
        if (res && res.ok) {
          console.log('Report acknowledged');
        }
      });
      addMessage('Reporting this user. Thank you for helping keep the community safe.', 'system');
    });
  }

  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      closeSheet();
      addMessage('Settings feature coming soon.', 'system');
    });
  }

  if (supportBtn) {
    supportBtn.addEventListener('click', () => {
      closeSheet();
      addMessage('Support: contact anonchat@example.com', 'system');
    });
  }

  if (exitBtn) {
    exitBtn.addEventListener('click', () => {
      closeSheet();
      if (roomId && userId && socket && socket.connected) {
        socket.emit('leave', {roomId, userId}, (err, res) => {
          if (res && res.ok) {
            console.log('Report acknowledged');
          }
        });
      }
      resetToStart();
    });
  }
}

function wireInterestsOverlay() {
  const interestsButton = document.getElementById('interestsButton');
  const interestsFilter = document.getElementById('interestsFilter');
  const closeFilter = document.getElementById('closeFilter');
  const applyInterests = document.getElementById('applyInterests');
  const interestCards = document.querySelectorAll('.interest-card');

  if (!interestsFilter) return;

  interestCards.forEach(card => {
    const key = card.getAttribute('data-interest');
    if (selectedInterests.includes(key)) {
      card.classList.add('active');
    }
    card.addEventListener('click', () => {
      card.classList.toggle('active');
      const interest = card.getAttribute('data-interest');
      if (!interest) return;
      if (card.classList.contains('active')) {
        if (!selectedInterests.includes(interest)) {
          selectedInterests.push(interest);
        }
      } else {
        selectedInterests = selectedInterests.filter(i => i !== interest);
      }
    });
  });

  if (interestsButton) {
    interestsButton.addEventListener('click', () => {
      interestsFilter.classList.add('active');
    });
  }

  if (closeFilter) {
    closeFilter.addEventListener('click', () => {
      interestsFilter.classList.remove('active');
    });
  }

  if (applyInterests) {
    applyInterests.addEventListener('click', () => {
      localStorage.setItem('interests', JSON.stringify(selectedInterests));
      interestsFilter.classList.remove('active');
      if (socket && socket.connected) {
        socket.emit('message', JSON.stringify({
          type:"interest_updated",
          userId,
          interests: selectedInterests,
        }));
      }
    });
  }
}

function wireSkipButton() {
  const skipButton = document.getElementById('skipButton');
  if (!skipButton) return;
  let skipConfirmActive = false;
  let skipTimeout = null;

  skipButton.addEventListener('click', function() {
    if (!skipConfirmActive) {
      skipConfirmActive = true;
      this.classList.add('confirm');
      this.innerHTML = '<i class="fas fa-check"></i>';
      skipTimeout = setTimeout(() => {
        skipConfirmActive = false;
        this.classList.remove('confirm');
        this.innerHTML = '<i class="fas fa-forward"></i>';
      }, 3000);
    } else {
      clearTimeout(skipTimeout);
      skipConfirmActive = false;
      this.classList.remove('confirm');
      this.innerHTML = '<i class="fas fa-forward"></i>';
      skipConversation();
    }
  });
}

function wireUI() {
  wireSelectionAndAge();
  wireChatInput();
  wireInterestsOverlay();
  wireMenuSheet();
  wireSkipButton();
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => initChat(), 100);
  });
} else {
  setTimeout(() => initChat(), 100);
}
