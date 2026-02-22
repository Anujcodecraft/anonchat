import Redis from 'ioredis';
import dotenv from 'dotenv'
import { createClient } from 'redis';

dotenv.config();
console.log("url is ", process.env.REDIS_URL);

export const sub = new Redis(process.env.REDIS_URL || 'anonchat-redis://127.0.0.1:6379');   // for subscription
export const pub = new Redis(process.env.REDIS_URL || 'anonchat-redis://127.0.0.1:6379');   // for publishing
export const redis = new Redis(process.env.REDIS_URL || 'anonchat-redis://127.0.0.1:6379'); // for commands

// export const pub = createClient({
//     username: 'default',
//     password: 'yKeJ3VBPk0lJ2p9Dpz4QpJnCD0SWXjrR',
//     socket: {
//         host: 'redis-11104.crce206.ap-south-1-1.ec2.cloud.redislabs.com',
//         port: 11104
//     }
// });
// export const sub = createClient({
//     username: 'default',
//     password: 'yKeJ3VBPk0lJ2p9Dpz4QpJnCD0SWXjrR',
//     socket: {
//         host: 'redis-11104.crce206.ap-south-1-1.ec2.cloud.redislabs.com',
//         port: 11104
//     }
// });
// export const redis = createClient({
//     username: 'default',
//     password: 'yKeJ3VBPk0lJ2p9Dpz4QpJnCD0SWXjrR',
//     socket: {
//         host: 'redis-11104.crce206.ap-south-1-1.ec2.cloud.redislabs.com',
//         port: 11104
//     }
// });
