// public/app.js
// Socket connection only - shared across chat and call

let socket = null;
let heartbeatTimer = null;
let userId = localStorage.getItem("userId");
let instanceId = localStorage.getItem('instanceId');

export const getUserId = () =>{
  let userID = localStorage.getItem("userId");
  if (!userID) {
    userID = crypto.randomUUID(); // or uuidv4()
    localStorage.setItem("userId", userID);
  }
  return userID;
}

export function connectSocket() {
  if (socket) return socket;

  socket = io({
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    auth:{
      userId:getUserId()
    }
  });

  socket.on('connect', () => {
    console.log('socket connected:', socket.id);
    onSocketReady();
  });

  socket.on('disconnect', reason => {
    console.log('socket disconnected:', reason);
  });

  socket.on('connect_error', err => {
    console.error('connection error:', err.message);
  });

  return socket;
}

function onSocketReady() {
  // console.log("userId ", userId, instanceId);
  if (userId) {
    socket.emit('message', JSON.stringify({type:"resume", userId, instanceId, want:localStorage.getItem("want") }));
  } else {
    socket.emit('message', JSON.stringify({type:"auth", userId }));
  }

  startHeartbeat();
}

export function startHeartbeat() {
  if (heartbeatTimer) return;

  heartbeatTimer = setInterval(() => {
    if (socket.connected && userId) {
      socket.emit('hb', { userId });
    }
  }, 10000);
}

export function getSocket() {
  return socket;
}

export function setUserId(id) {
  userId = id;
  localStorage.setItem('userId', id);
}

export function getInstanceId() {
  return instanceId;
}


export function setInstanceId(id) {
  instanceId = id;
  localStorage.setItem('instanceId', id);
}

// Initialize on load
console.log("type of window ", typeof window);
if (typeof window !== 'undefined') {
  connectSocket();
}

