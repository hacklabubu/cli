import { describe, expect, it } from 'vitest'

import { referralMessage, referralUrl } from './referral.js'

describe('referralUrl', () => {
  it('hangs the handle off the site root as a ref query param', () => {
    expect(referralUrl('ada-lovelace', 'https://hacklab.so')).toBe(
      'https://hacklab.so/?ref=ada-lovelace'
    )
  })

  it('does not double the slash when base already ends in one', () => {
    expect(referralUrl('grace', 'https://hacklab.so/')).toBe(
      'https://hacklab.so/?ref=grace'
    )
  })

  it('percent-encodes a handle with url-unsafe characters', () => {
    expect(referralUrl('a b&c', 'https://hacklab.so')).toBe(
      'https://hacklab.so/?ref=a%20b%26c'
    )
  })

  it('honors a non-production backend base', () => {
    expect(referralUrl('dev', 'http://localhost:3000')).toBe(
      'http://localhost:3000/?ref=dev'
    )
  })
})

describe('referralMessage', () => {
  it('ends with the referral link so the whole blurb is one paste', () => {
    const msg = referralMessage('ada', 'https://hacklab.so')
    expect(msg.endsWith('https://hacklab.so/?ref=ada')).toBe(true)
  })

  it('embeds the same url referralUrl produces', () => {
    const msg = referralMessage('ada', 'https://hacklab.so')
    expect(msg).toContain(referralUrl('ada', 'https://hacklab.so'))
  })
})
