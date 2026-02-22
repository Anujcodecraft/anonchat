# Matching Flow Explanation

## 1. Queue Name Format

When a user sends a `join` message, they are stored in a Redis queue with the following naming pattern:

```
wait:{type}:{gender}:{preference}
```

**Example:**
- User wants: `chat`
- User gender: `male`
- User preference: `female`
- **Queue name:** `wait:chat:male:female`

## 2. How Users Are Added to Queue

When a user joins:
```javascript
// Line 172: Create queue key
const q = queueKey(want, gender, preference);  // e.g., "wait:chat:male:female"

// Line 175: Add user to queue (LEFT PUSH - adds to front)
await redis.lpush(q, userId);  // userId is pushed to the LEFT of the list
```

**Redis Command:** `LPUSH wait:chat:male:female userId123`
- This adds the userId to the **left (front)** of the list
- The queue is a Redis LIST data structure

## 3. How Matching Works

### Step 1: User is added to their own queue
User A (male, wants female) → Added to `wait:chat:male:female`

### Step 2: Server tries to find a match
The server tries multiple queue combinations in order:

```javascript
const attempts = [
  queueKey(want, preference, gender),    // 1. "wait:chat:female:male" (exact match)
  queueKey(want, preference, 'any'),    // 2. "wait:chat:female:any"  (preference match)
  queueKey(want, 'any', 'any'),         // 3. "wait:chat:any:any"     (anyone)
  queueKey(want, 'any', 'any')         // 4. "wait:chat:any:any"     (duplicate, but safe)
];
```

**Example for User A (male, wants female):**
1. Try `wait:chat:female:male` - Look for females who want males
2. Try `wait:chat:female:any` - Look for females who want anyone
3. Try `wait:chat:any:any` - Look for anyone

### Step 3: Lua Script Executes

The Lua script is called with:
- **targetQueue**: The queue to search (e.g., `wait:chat:female:male`)
- **myUserId**: The current user's ID
- **myRecentKey**: `recent:{userId}` (to avoid rematching)
- **TTLs**: Time-to-live values
- **roomId**: New room ID to create

### Step 4: Lua Script Process

```lua
while true do
  -- 1. POP a user from the RIGHT of the target queue
  local partner = redis.call('RPOP', targetQueue)
  
  if not partner then
    return nil  -- No one in queue, no match
  end
  
  -- 2. Check if partner still has active session
  local sessKey = 'sess:' .. partner
  local partnerExists = redis.call('EXISTS', sessKey)
  
  if partnerExists == 0 then
    -- Partner disconnected, skip and try next user
    -- Loop continues to next iteration
  else
    -- 3. Check if we recently matched (avoid immediate rematch)
    local isRecentForMe = redis.call('SISMEMBER', myRecentKey, partner)
    local amRecentForPartner = redis.call('SISMEMBER', partnerRecent, myUserId)
    
    if isRecentForMe == 1 or amRecentForPartner == 1 then
      -- We recently matched, skip and try next
      -- Loop continues
    else
      -- 4. VALID MATCH FOUND!
      -- Create room
      redis.call('HMSET', roomKey, 'a', myUserId, 'b', partner)
      
      -- Remove session keys (mark as matched)
      redis.call('DEL', 'sess:' .. myUserId)
      redis.call('DEL', sessKey)
      
      -- Add to recent sets (prevent rematch for 600 seconds)
      redis.call('SADD', 'recent:' .. myUserId, partner)
      redis.call('SADD', 'recent:' .. partner, myUserId)
      
      return partner  -- Return matched partner ID
    end
  end
end
```

## 4. How Users Get Out of Queue

Users are removed from the queue in **TWO ways**:

### A. Successful Match (RPOP)
- The Lua script uses `RPOP` (Right POP) to remove a user from the **right (back)** of the queue
- This is **atomic** - only one user can be popped at a time
- If match is successful, the user is removed and a room is created
- If match fails (stale session, recent match), the script continues to pop the next user

### B. Session Expiry
- If a user's session expires (60 seconds TTL), they become "stale"
- The Lua script skips stale users but **doesn't remove them from queue**
- They remain in queue until:
  - Someone successfully matches with them (then they're removed)
  - Their session TTL expires and they're cleaned up
  - They disconnect and reconnect (new session)

## 5. Queue Structure (Redis LIST)

```
wait:chat:male:female = [userId3, userId2, userId1]
                         ↑                    ↑
                      (LEFT)              (RIGHT)
                      (newest)           (oldest)
```

- **LPUSH**: Adds to LEFT (new users go to front)
- **RPOP**: Removes from RIGHT (oldest users matched first)
- This creates a **FIFO (First In, First Out)** queue

## 6. Complete Flow Example

**Scenario:** User A (male, wants female) joins

1. **User A joins:**
   - Added to: `wait:chat:male:female` (LPUSH)
   - Queue: `[userA]`

2. **Server tries to match:**
   - Tries queue: `wait:chat:female:male`
   - Lua script RPOPs from this queue
   - If User B (female, wants male) is there → **MATCH!**
   - Both removed from queues, room created

3. **If no match:**
   - User A stays in `wait:chat:male:female`
   - Receives `waiting` message
   - When User B (female, wants male) joins later:
     - User B added to `wait:chat:female:male`
     - User B's matching process finds User A in `wait:chat:male:female`
     - **MATCH!**

## 7. Key Points

- **LPUSH** (add to front) + **RPOP** (remove from back) = FIFO queue
- Lua script runs **atomically** - no race conditions
- Users are only removed when successfully matched
- Stale users (disconnected) are skipped but not removed
- Recent matches are tracked to prevent immediate rematching
