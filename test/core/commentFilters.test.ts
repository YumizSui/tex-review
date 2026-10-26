import {describe,it,expect} from 'vitest';
import {commentTags,commentMatches,commentPreview,commentTypeTags} from '../../src/core/commentFilters';
import {fold} from '../../src/core/events';
const event={op:'add_thread' as const,id:'t1',file:'a.tex',range:{startLine:2,endLine:2},snapshot:'original passage',body:'Check antibody affinity.',author:'reviewer',ts:'2026-10-25T00:00:00Z'};
describe('comment tags and search',()=>{
 it('treats old or unspecified tags as action required without rewriting history',()=>{
  expect(commentTags()).toEqual(['action']);expect(commentTags([])).toEqual(['action']);
  expect(fold('review',[event]).threads[0].tags).toEqual(['action']);expect(event).not.toHaveProperty('tags');
 });
 it('persists several tags independently of resolved status and preserves quote and replies',()=>{
  const thread=fold('review',[event,{op:'reply',thread:'t1',body:'Reply text',author:'agent',ts:event.ts},{op:'set_tags',thread:'t1',tags:['question','note'],ts:event.ts},{op:'resolve',thread:'t1',ts:event.ts}]).threads[0];
  expect(thread.tags).toEqual(['question','note']);expect(thread.status).toBe('resolved');expect(thread.snapshot).toBe('original passage');expect(thread.comments).toHaveLength(2);
 });
 it('searches visible replies, normalizes case and width, and combines words with AND',()=>{
  const thread=fold('review',[event,{op:'reply',thread:'t1',body:'ＡＢＣ and カタカナ',author:'agent',ts:event.ts}]).threads[0];
  expect(commentMatches(thread,'ANTIBODY abc')).toBe(true);expect(commentMatches(thread,'ｶﾀｶﾅ')).toBe(true);expect(commentMatches(thread,'absent')).toBe(false);
  expect(commentPreview(thread,'abc')).toContain('ＡＢＣ');expect(commentMatches(thread,'original passage')).toBe(false);
 });
 it('combines tag filters with OR, and search with the tag result',()=>{
  const thread=fold('review',[{...event,tags:['question','todo']}]).threads[0];
  expect(commentMatches(thread,'antibody',['action','question'])).toBe(true);expect(commentMatches(thread,'antibody',['note'])).toBe(false);expect(commentMatches(thread,'absent',['question'])).toBe(false);
 });
 it('does not match a deleted reply',()=>{
  const thread=fold('review',[event,{op:'reply',thread:'t1',body:'Removed keyword',author:'agent',ts:event.ts},{op:'delete_comment',comment:'t1.c2',ts:event.ts}]).threads[0];expect(commentMatches(thread,'Removed')).toBe(false);
 });
});

it('accepts one type for new writes and retains multiple tags only when reading historical events',()=>{
 expect(commentTypeTags(['todo'])).toEqual(['todo']);expect(commentTypeTags([])).toEqual(['action']);
 expect(()=>commentTypeTags(['question','todo'])).toThrow('Choose one');expect(()=>commentTypeTags(['invalid'])).toThrow('Choose one');
 expect(commentTags(['question','todo'])).toEqual(['question','todo']);
});


describe('AI reply filters', () => {
 const thread = (extra: any[] = []) => fold('review', [event, ...extra]).threads[0];
 const reply = {op:'reply' as const,thread:'t1',body:'Changed the passage.',author:'agent',ts:event.ts};
 it('finds AI replies only on unresolved threads and combines type and search', () => {
  const open = thread([reply]);
  expect(commentMatches(open, 'passage', ['action'], 'ai-replied')).toBe(true);
  expect(commentMatches(open, '', ['todo'], 'ai-replied')).toBe(false);
  expect(commentMatches(thread([reply,{op:'resolve',thread:'t1',ts:event.ts}]), '', [], 'ai-replied')).toBe(false);
  expect(commentMatches(thread(), '', [], 'no-ai-reply')).toBe(true);
 });
 it('does not treat a human reply or an AI-authored opening comment as an AI reply', () => {
  expect(commentMatches(thread([{...reply,author:'reviewer'}]), '', [], 'ai-replied')).toBe(false);
  const opening = fold('review', [{...event,author:'agent'}]).threads[0];
  expect(commentMatches(opening, '', [], 'no-ai-reply')).toBe(true);
 });
 it('updates when an AI reply is deleted, or a resolved thread is reopened', () => {
  expect(commentMatches(thread([reply,{op:'delete_comment',comment:'t1.c2',ts:event.ts}]), '', [], 'no-ai-reply')).toBe(true);
  expect(commentMatches(thread([reply,{op:'resolve',thread:'t1',ts:event.ts},{op:'reopen',thread:'t1',ts:event.ts}]), '', [], 'ai-replied')).toBe(true);
 });
});
