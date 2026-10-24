import { describe,it,expect,vi } from 'vitest';
import { performanceMonitor } from '../../media/performance.js';
describe('local slow-operation diagnostics',()=>{
 it('reports slow synchronous work but leaves fast operations silent',()=>{
  let clock=0;const report=vi.fn(),monitor=performanceMonitor(report,()=>clock);
  expect(monitor.measure('source.update',()=>{clock+=20;return 'result';})).toBe('result');expect(report).not.toHaveBeenCalled();
  monitor.measure('comments.measure',()=>{clock+=70;});expect(report).toHaveBeenCalledWith({phase:'comments.measure',milliseconds:70});
 });
 it('preserves failures while recording how long the failing operation took',()=>{
  let clock=0;const report=vi.fn(),monitor=performanceMonitor(report,()=>clock);
  expect(()=>monitor.measure('source.compare',()=>{clock=100;throw Error('failure');})).toThrow('failure');
  expect(report).toHaveBeenCalledWith({phase:'source.compare',milliseconds:100});
 });
});
