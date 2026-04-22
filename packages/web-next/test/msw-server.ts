import { setupServer } from 'msw/node'
import { handlers } from './msw-handlers'

// Single MSW server instance shared across all test files.
// setup.ts calls server.listen / server.resetHandlers / server.close.
export const server = setupServer(...handlers)
