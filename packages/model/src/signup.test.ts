import { describe, expect, it } from 'vitest';
import {
  companyDomain,
  emailDomain,
  emailKey,
  nameSearchTerm,
  normaliseOrgName,
  sameOrgName,
  trialKeys,
} from './signup';

describe('organisation names', () => {
  it('ignores case, punctuation and company suffixes', () => {
    expect(normaliseOrgName('Acme AV Pty. Ltd.')).toBe('acme av');
    expect(sameOrgName('ACME  AV', 'acme-av pty ltd')).toBe(true);
    expect(sameOrgName('Acme & Sons', 'Acme and Sons Inc')).toBe(true);
  });
  it('treats different names as different', () => {
    expect(sameOrgName('Acme AV', 'Acme Audio')).toBe(false);
  });
  it('never matches a name that is only noise', () => {
    expect(sameOrgName('The Company Ltd', 'Pty Ltd')).toBe(false);
  });
  it('searches on the first meaningful word', () => {
    expect(nameSearchTerm('The Acme AV Pty Ltd')).toBe('acme');
    expect(nameSearchTerm('Ltd')).toBeNull();
  });
});

describe('email domains', () => {
  it('reads the domain after the last @', () => {
    expect(emailDomain('Bob@Acme.COM')).toBe('acme.com');
    expect(emailDomain('nonsense')).toBeNull();
    expect(emailDomain('a@localhost')).toBeNull();
    expect(emailDomain(null)).toBeNull();
  });
  it('ignores free mail providers', () => {
    expect(companyDomain('bob@gmail.com')).toBeNull();
    expect(companyDomain('bob@outlook.com.au')).toBeNull();
    expect(companyDomain('bob@acme.com.au')).toBe('acme.com.au');
  });
});

describe('mailbox keys', () => {
  it('strips +labels and Gmail dots', () => {
    expect(emailKey('Steve.Mayo+trial2@gmail.com')).toBe('stevemayo@gmail.com');
    expect(emailKey('steve.mayo@googlemail.com')).toBe('stevemayo@gmail.com');
  });
  it('keeps dots in other domains', () => {
    expect(emailKey('steve.mayo+x@acme.com')).toBe('steve.mayo@acme.com');
  });
  it('gives nothing for a malformed address', () => {
    expect(emailKey('+@acme.com')).toBeNull();
    expect(emailKey('nope')).toBeNull();
  });
  it('counts a company address against the person, mailbox and company', () => {
    expect(trialKeys('u1', 'a@acme.com')).toEqual({
      userId: 'u1',
      emailKey: 'a@acme.com',
      domainKey: 'acme.com',
    });
    expect(trialKeys('u1', 'a@gmail.com').domainKey).toBeNull();
  });
});
