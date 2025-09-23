// Jest setup file for WhatsApp Web Service tests

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
process.env.MEDIA_BUCKET = 'test-media-bucket';
process.env.STORAGE_BUCKET = 'test-storage-bucket';
process.env.MAX_FILE_SIZE_MB = '16';
process.env.API_KEY = 'test-api-key';
process.env.PORT = '8080';

// Mock console methods to reduce noise in test output
global.console = {
  ...console,
  // Keep log/error for debugging, but silence debug/info in tests
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};

// Global test timeout
jest.setTimeout(30000);

// Clean up after each test
afterEach(() => {
  jest.clearAllMocks();
});