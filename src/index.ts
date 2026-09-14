#!/usr/bin/env node
/**
 * stdio entry point.
 *
 * stdout belongs to the JSON-RPC transport. Every diagnostic in this process
 * goes to stderr, and `redirectConsoleToStderr()` is installed first so that a
 * stray `console.log` anywhere in the dependency tree cannot corrupt the stream.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { log, redirectConsoleToStderr, setLogLevel } from './logger.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  if (process.env['HIM_STRICT_STDOUT'] !== '0') {
    redirectConsoleToStderr();
  }

  const { server, config } = createServer();
  const level = setLogLevel(config.logLevel);

  const transport = new StdioServerTransport();
  transport.onclose = () => {
    log.info('client closed the stdio transport; exiting');
    process.exit(0);
  };

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}; shutting down`);
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await server.connect(transport);

  log.info(
    `ready (log=${level}, fallback=${config.fallback}, timeout=${config.timeoutMs}ms, multi_select=${config.multiSelectMode})`
  );
}

main().catch(error => {
  log.error('fatal:', error);
  process.exit(1);
});
