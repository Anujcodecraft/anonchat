# Redis-Based Routing Implementation

## Changes Made

### Removed Direct Local Socket Lookup
Previously, the code used `localSockets.get(userId)` directly for routing. Now all routing goes through Redis.

### New Architecture

1. **Redis HashMap for Connections**
   - Key: `connections` (CONNECTION_HASH_KEY)
   - Structure: `userId -> instanceId`
   - Stores which instance each user is connected to
   - Persists even after matching (unlike sessions which are deleted)

2. **Redis Sessions** (still used)
   - Key: `sess:{userId}`
   - Contains session metadata
   - Deleted by Lua script when matched (for security)

3. **Local Socket Map** (minimal use)
   - Only stores WebSocket objects
   - Used ONLY for receiving pub/sub messages
   - NOT used for routing decisions

## How Routing Works Now

### 1. User Connects
```javascript
// Store in Redis hashmap
await redis.hset('connections', userId, INSTANCE_ID);
// Store session
await redis.set(`sess:${userId}`, {...}, 'EX', 60);
// Store WebSocket locally (for pub/sub delivery only)
localSockets.set(userId, ws);
```

### 2. Sending Messages
```javascript
// 1. Check Redis hashmap for user's instance
const instanceId = await redis.hget('connections', userId);

// 2. If same instance -> use local socket
if (instanceId === INSTANCE_ID) {
  const ws = localSockets.get(userId);
  safeSend(ws, payload);
}

// 3. If different instance -> use Redis pub/sub
else {
  pub.publish(`instance:${instanceId}`, {...});
}
```

### 3. User Disconnects
```javascript
// Remove from Redis hashmap
await redis.hdel('connections', userId);
// Delete session
await redis.del(`sess:${userId}`);
// Remove from local sockets
localSockets.delete(userId);
```

## Key Differences from Previous Implementation

### Before:
- Direct lookup: `localSockets.get(userId)` for routing
- Sessions used for cross-instance routing
- Sessions deleted by Lua, causing routing failures

### After:
- All routing via Redis hashmap: `redis.hget('connections', userId)`
- Sessions still exist but not used for routing
- Connections persist after matching (for message routing)
- More reliable cross-instance routing

## Benefits

1. **Centralized State**: All connection info in Redis
2. **Scalable**: Works across multiple server instances
3. **Reliable**: Connections persist even after matching
4. **Clean Separation**: Routing logic separate from WebSocket objects

## Redis Keys Used

1. `connections` (Hashmap)
   - Stores: `userId -> instanceId`
   - Purpose: Routing decisions
   - TTL: None (manual cleanup on disconnect)

2. `sess:{userId}` (String)
   - Stores: Session metadata
   - Purpose: Session tracking
   - TTL: 60 seconds (refreshed by heartbeat)
   - Deleted: When matched (by Lua script)

3. `instance:{instanceId}` (Pub/Sub Channel)
   - Purpose: Cross-instance message routing
   - Used: For sending messages to other instances

## Important Notes

- **Connections hashmap is NOT deleted when users match** - only sessions are deleted
- **Local sockets map is minimal** - only stores WebSocket objects for pub/sub delivery
- **All routing decisions use Redis hashmap** - no direct local socket lookups for routing
- **Heartbeat updates both session AND connection hashmap** - ensures routing info stays fresh
