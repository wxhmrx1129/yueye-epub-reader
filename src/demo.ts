/** Original, bundled sample book; importing it follows the same path as any EPUB. */
export async function demoFile(): Promise<File> {
  const response = await fetch(`${import.meta.env.BASE_URL}demo.epub`);
  if (!response.ok) throw new Error('示例图书暂时无法加载，请重试或导入自己的 EPUB。');
  return new File([await response.blob()], '把日子读成诗.epub', { type: 'application/epub+zip' });
}
