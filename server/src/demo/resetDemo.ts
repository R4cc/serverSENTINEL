import { hashPassword } from "../auth/passwords.js";
import { config } from "../config.js";
import { ensureDemoUser } from "../demoMode.js";
import { openStorageDatabase } from "../storage/database.js";
import { initializeRuntimeDataRoot } from "../storage/runtimePaths.js";
import { UsersRepository } from "../storage/usersRepository.js";

if (!config.enableDemo) {
  throw new Error("Refusing to reset demo mode unless SERVERSENTINEL_ENABLE_DEMO=true");
}

initializeRuntimeDataRoot(config.paths);
const storage = openStorageDatabase();
try {
  const user = ensureDemoUser(new UsersRepository(storage), hashPassword);
  storage.connection.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
  console.log(`Demo mode reset in ${config.dataDir}. Sign in with demo / demo.`);
} finally {
  storage.close();
}
