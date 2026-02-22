# Redis Keys Explanation & Matchmaking Debugging

## What Each Key Type Means

### 1. `room:{roomId}` - Chat Room
**Example:** `room:91d7162a-40f5-4d90-b547-7f0b07e9bfcf`

**Created when:** Two users are successfully matched
**Contains:** 
- `a`: First user's ID
- `b`: Second user's ID
- TTL: 600 seconds (10 minutes)

**What it means:**
- A match was found and a room was created
- Both users should be able to chat in this room
- **Problem:** If you see multiple rooms, it means matches ARE happening, but users might not be receiving the matched messages

### 2. `recent:{userId}` - Recent Matches Set
**Example:** `recent:8dfc43a9-3fbe-4ea6-863d-30aea198f5df`

**Created when:** A user successfully matches with someone
**Contains:** Set of user IDs that this user recently matched with
**TTL:** 600 seconds (10 minutes)

**What it means:**
- Prevents users from matching with the same person immediately again
- If you see this key, it means a match occurred
- The user ID in the key is one of the matched users

### 3. `sess:{userId}` - Active Session
**Example:** `sess:609bd835-734f-4eb0-bcf9-83ac080d43d6`

**Created when:** A user connects via WebSocket
**Contains:**
- `instance`: Server instance ID
- `ts`: Timestamp
**TTL:** 60 seconds (refreshed by heartbeat)

**What it means:**
- User is currently connected
- **Problem:** Sessions should be DELETED when matched (see Lua script line 43-44)
- If sessions still exist after matching, it could mean:
  1. The matched message wasn't sent properly
  2. User reconnected after being matched
  3. Match happened but notification failed

### 4. Queue Keys: `wait:chat:{gender}:{preference}`
**Example:** `wait:chat:male:female`

**Contains:** List of user IDs waiting to be matched
**Structure:** Redis LIST (FIFO queue)

**What it means:**
- Users are waiting in these queues
- Should be checked if matchmaking isn't working

---

## Why Matchmaking Might Not Be Working

### Problem 1: Rooms Created But Users Not Notified

**Symptoms:**
- You see `room:*` keys created ✅
- You see `recent:*` keys created ✅
- But users aren't getting matched messages ❌

**Root Cause:**
The Lua script successfully creates the room and deletes sessions, but `sendToUser()` might be failing because:
1. Sessions were deleted BEFORE notification was sent
2. Users reconnected and got new session keys
3. Redis routing between instances failed

**Check this in your code:**
```javascript
// Line 203-209 in server.js
if (matchedPartner) {
  const payloadForA = { type: 'matched', roomId, partnerId: matchedPartner };
  const payloadForB = { type: 'matched', roomId, partnerId: userId };
  
  await sendToUser(userId, payloadForA);        // ← Might fail if session deleted
  await sendToUser(matchedPartner, payloadForB); // ← Might fail if session deleted
}
```

**The Issue:**
The Lua script DELETES sessions (line 43-44) BEFORE the Node.js code can send notifications. This means `sendToUser()` can't find the sessions!

### Problem 2: Sessions Deleted Too Early

Looking at the Lua script:
```lua
-- Remove session keys to mark matched
redis.call('DEL', 'sess:' .. myUserId)      -- ← Deletes User A's session
redis.call('DEL', sessKey)                  -- ← Deletes User B's session
```

But then in server.js:
```javascript
await sendToUser(userId, payloadForA);  // ← Tries to find session, but it's deleted!
```

**Solution:** We need to send notifications BEFORE deleting sessions, or store the WebSocket connections before matching.

---

## Debugging Steps

### Step 1: Check Queue Status
Run in Redis CLI:
```bash
redis-cli
> KEYS wait:*
> LLEN wait:chat:male:female
> LRANGE wait:chat:male:female 0 -1
```

This shows if users are stuck in queues.

### Step 2: Check Room Contents
```bash
> HGETALL room:91d7162a-40f5-4d90-b547-7f0b07e9bfcf
```

Shows which users are in the room.

### Step 3: Check Session Status
```bash
> GET sess:609bd835-734f-4eb0-bcf9-83ac080d43d6
> TTL sess:609bd835-734f-4eb0-bcf9-83ac080d43d6
```

Shows if session exists and how long until expiry.

### Step 4: Check Recent Matches
```bash
> SMEMBERS recent:8dfc43a9-3fbe-4ea6-863d-30aea198f5df
```

Shows who this user recently matched with.

---

## The Critical Bug

**The problem is in the order of operations:**

1. ✅ Lua script creates room
2. ✅ Lua script deletes sessions
3. ❌ Node.js tries to send notifications using deleted sessions
4. ❌ `sendToUser()` fails because sessions don't exist
5. ❌ Users never receive "matched" message

**Fix:** We need to send notifications BEFORE the Lua script deletes sessions, OR we need to store WebSocket connections locally before matching.

---

## What's Happening in Your Case

Based on your Redis keys:

1. **Multiple rooms created** → Matches ARE happening in Lua
2. **Sessions still exist** → Either:
   - Users reconnected after match
   - Sessions weren't deleted (unlikely)
   - New sessions created after match
3. **Recent keys exist** → Confirms matches occurred

**Conclusion:** The matching logic works, but users aren't being notified. The `sendToUser()` function is failing because sessions are deleted before notifications are sent.

---

## Recommended Fix

We need to send notifications BEFORE deleting sessions. Here's the fix approach:

1. Store WebSocket connections in `localSockets` BEFORE matching
2. Send notifications immediately after match
3. Only then let Lua delete sessions (or delete them after sending)

Let me prepare a fix for this issue.
