import { app } from "./app.js";
import { env } from "./config.js";
import { sqliteReady } from "./db.js";

await sqliteReady;

app.listen(env.PORT, () => {
  console.log(`Server listening on port ${env.PORT}`);
});
