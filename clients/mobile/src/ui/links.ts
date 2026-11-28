import { Linking, Platform } from 'react-native';
import { safeHttpUrl } from './url';

export { safeHttpUrl };

export async function openExternal(raw: string | null | undefined): Promise<boolean> {
  const url = safeHttpUrl(raw);
  if (!url) return false;
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    // A new tab, without giving it a handle on this page.
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }
  await Linking.openURL(url);
  return true;
}

/**
 * Opens a link that has to be fetched first (the claim link). On the web the tab is opened at once, inside the click,
 * so the browser does not treat it as an unrequested popup; it is pointed at the link when it arrives, or closed if
 * there is none or it is not http(s). Returns whether something was opened.
 */
export async function openExternalLater(get: () => Promise<string | null>): Promise<boolean> {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null; // no handle back on this page
    try {
      const url = safeHttpUrl(await get());
      if (!url) {
        tab?.close();
        return false;
      }
      if (tab) tab.location.href = url;
      else window.open(url, '_blank', 'noopener,noreferrer');
      return true;
    } catch (e) {
      tab?.close();
      throw e;
    }
  }
  return openExternal(await get());
}
