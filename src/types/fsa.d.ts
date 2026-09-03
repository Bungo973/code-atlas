/**
 * File System Access API 的补充类型声明。
 * lib.dom 对 showDirectoryPicker 和目录迭代器的覆盖在各 TS 版本间不一致，
 * 这里显式声明，避免依赖具体 TS 版本的 lib 内容。
 */

interface FileSystemDirectoryHandleIterable extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
  values(): AsyncIterableIterator<FileSystemHandle>
  keys(): AsyncIterableIterator<string>
}

interface Window {
  showDirectoryPicker?: (options?: {
    id?: string
    mode?: 'read' | 'readwrite'
    startIn?: string
  }) => Promise<FileSystemDirectoryHandle>
}
