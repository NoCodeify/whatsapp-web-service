#!/usr/bin/env node

/**
 * Test script for phone number formatting
 * 
 * This script tests the phone number formatting functionality
 * to ensure that leading zeros after country codes are properly removed
 * and that phone numbers are formatted correctly for WhatsApp.
 */

const { formatPhoneNumberSafe, parsePhoneNumber, formatWhatsAppJid } = require('./dist/utils/phoneNumber');

console.log('📱 Phone Number Formatting Test');
console.log('================================\n');

// Test cases for various countries
const testCases = [
  // Netherlands - the main issue case
  { input: '+310658015937', expected: '+31658015937', country: 'Netherlands' },
  { input: '+31 0 658015937', expected: '+31658015937', country: 'Netherlands' },
  { input: '+31 06 5801 5937', expected: '+31658015937', country: 'Netherlands' },
  { input: '31 0658015937', expected: '+31658015937', country: 'Netherlands' },
  
  // France
  { input: '+330612345678', expected: '+33612345678', country: 'France' },
  { input: '+33 0 6 12 34 56 78', expected: '+33612345678', country: 'France' },
  { input: '33 06 12 34 56 78', expected: '+33612345678', country: 'France' },
  
  // Germany
  { input: '+490301234567', expected: '+49301234567', country: 'Germany' },
  { input: '+49 0 30 1234567', expected: '+49301234567', country: 'Germany' },
  { input: '49 030 1234567', expected: '+49301234567', country: 'Germany' },
  
  // Belgium
  { input: '+320471234567', expected: '+32471234567', country: 'Belgium' },
  { input: '+32 0 471 23 45 67', expected: '+32471234567', country: 'Belgium' },
  
  // Italy
  { input: '+390612345678', expected: '+39612345678', country: 'Italy' },
  { input: '+39 06 1234 5678', expected: '+39612345678', country: 'Italy' },
  
  // UK (no leading zero issue)
  { input: '+447911123456', expected: '+447911123456', country: 'UK' },
  { input: '+44 7911 123456', expected: '+447911123456', country: 'UK' },
  { input: '44 7911 123456', expected: '+447911123456', country: 'UK' },
  
  // US (no leading zero issue)
  { input: '+12133734253', expected: '+12133734253', country: 'US' },
  { input: '+1 213 373 4253', expected: '+12133734253', country: 'US' },
  { input: '1 (213) 373-4253', expected: '+12133734253', country: 'US' },
  
  // Invalid numbers
  { input: '+31', expected: null, country: 'Invalid - too short' },
  { input: '123456', expected: null, country: 'Invalid - no country code' },
  { input: 'not a number', expected: null, country: 'Invalid - not numeric' },
];

console.log('Running tests...\n');

let passed = 0;
let failed = 0;

testCases.forEach((test, index) => {
  try {
    const result = formatPhoneNumberSafe(test.input);
    const success = result === test.expected;
    
    if (success) {
      console.log(`✅ Test ${index + 1} PASSED: ${test.country}`);
      console.log(`   Input:    "${test.input}"`);
      console.log(`   Output:   "${result}"`);
      console.log(`   Expected: "${test.expected}"`);
      passed++;
    } else {
      console.log(`❌ Test ${index + 1} FAILED: ${test.country}`);
      console.log(`   Input:    "${test.input}"`);
      console.log(`   Output:   "${result}"`);
      console.log(`   Expected: "${test.expected}"`);
      failed++;
    }
    
    // Test WhatsApp JID formatting too
    if (result) {
      const jid = formatWhatsAppJid(test.input);
      const expectedJid = result ? `${result.substring(1)}@s.whatsapp.net` : null;
      console.log(`   JID:      "${jid}"`);
      if (jid !== expectedJid) {
        console.log(`   ⚠️  JID mismatch! Expected: "${expectedJid}"`);
      }
    }
    
    console.log('');
  } catch (error) {
    console.log(`❌ Test ${index + 1} ERROR: ${test.country}`);
    console.log(`   Input:    "${test.input}"`);
    console.log(`   Error:    ${error.message}`);
    console.log('');
    failed++;
  }
});

console.log('================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('');

if (failed === 0) {
  console.log('🎉 All tests passed! Phone number formatting is working correctly.');
  process.exit(0);
} else {
  console.log('⚠️  Some tests failed. Please review the phone number formatting logic.');
  process.exit(1);
}