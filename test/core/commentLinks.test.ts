import {describe,it,expect} from 'vitest';
import {commentLink,parseCommentLink} from '../../src/core/commentLinks';
describe('stable local comment links',()=>{
 it('round-trips a workspace, review, and stable thread ID without encoding source positions',()=>{
  const target={workspace:'/Users/example/論文 & notes',review:'日本語レビュー #1',thread:'t_abc-123'};
  for(const scheme of ['vscode','cursor']){
   const link=commentLink(scheme,'yumizsui.tex-review',target);expect(parseCommentLink(link)).toEqual(target);expect(parseCommentLink({path:'/comment',query:new URL(link).search.slice(1)})).toEqual(target);expect(link).not.toContain('line=');expect(link).not.toContain('body=');
  }
 });
 it('rejects unknown routes and incomplete links',()=>{
  expect(()=>parseCommentLink('vscode://yumizsui.tex-review/execute?workspace=x&review=r&thread=t')).toThrow();expect(()=>parseCommentLink('vscode://yumizsui.tex-review/comment?review=r')).toThrow();
 });
});
