// 標準入力のパスワードから、PostgreSQL の SCRAM-SHA-256 の検証用の値を作る（psql の \password と同じ形式）。
// これを ALTER ROLE ... PASSWORD に渡せば、平文のパスワードを DB に送らずに済む（ログや統計に平文が残らない）
//   printf %s "$pw" | node deploy/scripts/scram-verifier.mjs
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'

const chunks = []
for await (const c of process.stdin) chunks.push(c)
const password = Buffer.concat(chunks).toString('utf8')
if (!password) throw new Error('パスワードが空です')

const iterations = 4096
const salt = randomBytes(16)
const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256')
const clientKey = createHmac('sha256', salted).update('Client Key').digest()
const storedKey = createHash('sha256').update(clientKey).digest()
const serverKey = createHmac('sha256', salted).update('Server Key').digest()
process.stdout.write(
  `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`,
)
