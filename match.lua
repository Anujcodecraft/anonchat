-- helper: current time in ms
local function now_ms()
  local t = redis.call('TIME')
  return (t[1] * 1000) + math.floor(t[2] / 1000)
end

local now = now_ms()

local targetQueue      = ARGV[1]
local myUserId         = ARGV[2]
local myRecentKey      = ARGV[3]
local recentTTL        = tonumber(ARGV[4])
local roomTTL          = tonumber(ARGV[5])
local roomId           = ARGV[6]
local requireInterest  = tonumber(ARGV[7] or "0")
local maxScan          = tonumber(ARGV[8] or "50")
local claimTTL         = tonumber(ARGV[9] or "10000")

local myInterestsKey   = 'interests:' .. myUserId
local myBlockKey       = 'block:' .. myUserId

local attempts = 0
local bestScore = -1
local bestPartner = nil
local bestPartnerRecentKey = nil
local bestClaimKey = nil
local validPartners = {}

-- Cleanup old entries from recent set (using ZSET with timestamps)
local function cleanup_recent(key)
  redis.call(
    'ZREMRANGEBYSCORE',
    key,
    0,
    now_ms() - recentTTL
  )
end

local function finalize_match(partner, partnerRecentKey, claimKey)
  -- Set user_room mappings FIRST to prevent race conditions
  -- This ensures no other matcher can grab these users
  redis.call('SET', 'user_room:' .. myUserId, roomId)
  redis.call('SET', 'user_room:' .. partner, roomId)
  
  -- Now create the room
  local roomKey = 'room:' .. roomId
  redis.call('HMSET', roomKey, 'a', myUserId, 'b', partner)
  redis.call('EXPIRE', roomKey, roomTTL)
  
  -- Delete the claim key to free up the partner
  if claimKey then
    redis.call('DEL', claimKey)
  end
  
  -- Store recency with timestamp in sorted set
  redis.call('ZADD', myRecentKey, now_ms(), partner)
  redis.call('ZADD', partnerRecentKey, now_ms(), myUserId)
  
  -- Cleanup old entries
  cleanup_recent(myRecentKey)
  cleanup_recent(partnerRecentKey)
  
  return partner
end

while attempts < maxScan do
  attempts = attempts + 1
  
  local popped = redis.call('ZPOPMIN', targetQueue)
  if #popped == 0 then break end
  
  local partner = popped[1]
  
  repeat
    -- Skip if it's ourselves
    if partner == myUserId then
      redis.call('ZADD', targetQueue, now_ms(), partner)
      break
    end
    
    -- Check if partner session exists
    local sessKey = 'sess:' .. partner
    if redis.call('EXISTS', sessKey) == 0 then
      break
    end

    -- Try to claim this partner atomically
    local claimKey = 'match_claim:' .. partner
    local claimed = redis.call('SET', claimKey, myUserId, 'NX', 'PX', claimTTL)
    if not claimed then
      redis.call('ZADD', targetQueue, now_ms(), partner)
      break
    end
    
    -- ownership key
    local partnerRoomKey = 'user_room:' .. partner
    local existingRoomId = redis.call('GET', partnerRoomKey)
    local skipPartner = false

    -- read session
    local sessionRaw = redis.call('GET', sessKey)
    local session = nil

    if sessionRaw then
      session = cjson.decode(sessionRaw)
    end

    -- Case 1: Redis says user already owns a room
    if existingRoomId then
      local roomKey = 'room:' .. existingRoomId
      local mode = redis.call('HGET', roomKey, 'mode')
      if mode ~= 'bot' then
        skipPartner = true
      end

    -- Case 2: Redis missing ownership, but session claims IN_ROOM
    elseif session and session.state == "IN_ROOM" and session.roomId then
      local claimed = redis.call(
        'SET',
        partnerRoomKey,
        session.roomId,
        'NX',
        'PX',
        claimTTL
      )

      if claimed then
        -- healed ownership
        skipPartner = true
      else
        -- someone else recreated ownership
        local current = redis.call('GET', partnerRoomKey)
        if current == session.roomId then
          -- same room, refresh lease
          redis.call('PEXPIRE', partnerRoomKey, roomTTL)
          skipPartner = true
        else
          -- conflict: session is stale
          skipPartner = false
        end
      end
    end

    
    if skipPartner then
      redis.call('DEL', claimKey)
      redis.call('ZADD', targetQueue, now_ms(), partner)
      break
    end
    
    -- Check if partner is banned
    local banKey = 'ban:' .. partner
    if redis.call('EXISTS', banKey) == 1 then
      redis.call('DEL', claimKey)
      break
    end
    
    -- Check block lists
    local partnerBlockKey = 'block:' .. partner
    if redis.call('SISMEMBER', myBlockKey, partner) == 1 or
       redis.call('SISMEMBER', partnerBlockKey, myUserId) == 1 then
      redis.call('DEL', claimKey)
      redis.call('ZADD', targetQueue, now_ms(), partner)
      break
    end
    
    local partnerRecentKey = 'recent:' .. partner
    
    -- Cleanup before checking (using ZSET)
    cleanup_recent(myRecentKey)
    cleanup_recent(partnerRecentKey)
    
    -- Check if we've matched recently (using ZSCORE for ZSET)
    if redis.call('ZSCORE', myRecentKey, partner) or
       redis.call('ZSCORE', partnerRecentKey, myUserId) then
      redis.call('DEL', claimKey)
      redis.call('ZADD', targetQueue, now_ms(), partner)
      break
    end
    
    -- Calculate interest overlap score
    local score = 0
    local partnerInterestsKey = 'interests:' .. partner
    local myCount = redis.call('SCARD', myInterestsKey)
    local theirCount = redis.call('SCARD', partnerInterestsKey)
    
    if myCount > 0 and theirCount > 0 then
      local overlap = redis.call('SINTER', myInterestsKey, partnerInterestsKey)
      if #overlap == 0 and requireInterest == 1 then
        redis.call('DEL', claimKey)
        redis.call('ZADD', targetQueue, now_ms(), partner)
        break
      end
      score = #overlap
    elseif requireInterest == 1 then
      redis.call('DEL', claimKey)
      redis.call('ZADD', targetQueue, now_ms(), partner)
      break
    end
    
    -- Track this as a valid partner
    table.insert(validPartners, partner)
    
    -- Keep track of best match
    if bestPartner == nil or score > bestScore then
      -- Release previous best partner's claim
      if bestClaimKey then
        redis.call('DEL', bestClaimKey)
      end
      bestScore = score
      bestPartner = partner
      bestPartnerRecentKey = partnerRecentKey
      bestClaimKey = claimKey
    else
      -- Release this partner's claim since they're not the best
      redis.call('DEL', claimKey)
    end
    
  until true
end

-- Finalize the match with the best partner
if bestPartner ~= nil then
  -- Return all non-matched valid partners to queue
  for _, p in ipairs(validPartners) do
    if p ~= bestPartner then
      redis.call('ZADD', targetQueue, now_ms(), p)
    end
  end
  return finalize_match(bestPartner, bestPartnerRecentKey, bestClaimKey)
end

-- No match found, return all valid partners to queue
for _, p in ipairs(validPartners) do
  redis.call('ZADD', targetQueue, now_ms(), p)
end

return nil