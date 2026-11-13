// npm run db:seed -> crea el admin (pregunta correo y contraseña) y el cliente consumidor final
import readline from "node:readline";
import { Writable } from "node:stream";
import pg from "pg";
import bcrypt from "bcryptjs";

if (!process.env.DATABASE_URL) {
  console.error("Falta DATABASE_URL (en .env.local o en el entorno).");
  process.exit(1);
}

let muted = false;
const out = new Writable({
  write(chunk, _enc, cb) {
    if (!muted) process.stdout.write(chunk);
    cb();
  },
});
const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
const ask = (q, hide = false) =>
  new Promise((res) => {
    process.stdout.write(q);
    muted = hide;
    rl.question("", (a) => {
      muted = false;
      if (hide) process.stdout.write("\n");
      res(a.trim());
    });
  });

const name = (await ask("Nombre del administrador: ")) || "Administrador";
const email = (await ask("Correo del administrador: ")).toLowerCase();
// Siempre crea un ADMINISTRADOR: mínimo 12 caracteres (misma regla que src/lib/password-rules.ts)
const ADMIN_MIN_PASSWORD = 12;
const password = await ask(`Contraseña (mín. ${ADMIN_MIN_PASSWORD} caracteres): `, true);
rl.close();

if (!email.includes("@") || password.length < ADMIN_MIN_PASSWORD) {
  console.error(`Correo inválido o contraseña muy corta (un administrador necesita al menos ${ADMIN_MIN_PASSWORD} caracteres).`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  const hash = await bcrypt.hash(password, 10);
  await client.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1,$2,$3,'admin')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash,
       role='admin', active=TRUE, failed_attempts=0, locked_until=NULL`,
    [name, email, hash]
  );
  await client.query(
    `INSERT INTO customers (id_type, identification, first_name, last_name, siigo_synced)
     VALUES ('13','222222222222','Consumidor','final',FALSE)
     ON CONFLICT (identification) DO NOTHING`
  );
  console.log(`OK: admin ${email} listo y cliente consumidor final creado.`);
} catch (e) {
  console.error("Error:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
