/** Ask the copilot one question from the command line: npm run ask -- "Where is my order?" */
import { SupportCopilot } from "../src/copilot";
import { createProvider } from "../src/providers";

const message = process.argv.slice(2).join(" ").trim();
if (!message) {
  console.error('Usage: npm run ask -- "your customer message"');
  process.exit(2);
}

try {
  const copilot = new SupportCopilot({ provider: createProvider() });
  const { output, trace } = await copilot.answer(message);
  console.log(JSON.stringify({ output, trace }, null, 2));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
