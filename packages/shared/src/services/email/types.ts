/**
 * Shared types for the email classification pipeline.
 *
 * These types are used by both Hotmail (Graph API) and Gmail (Gmail API)
 * provider implementations, as well as the email classification skill.
 */

export interface EmailMessage {
  messageId: string
  provider: 'hotmail' | 'gmail'
  sender: string       // email address
  subject: string
  receivedAt: string   // ISO timestamp
  bodyPreview?: string  // first 200 chars
}

export interface EmailFolder {
  id: string
  name: string
  parentFolderId?: string
}

export interface ClassifiedEmail extends EmailMessage {
  category: string
  confidence: number
  tier: 'sender' | 'keyword' | 'jetson' | 'manual'
  folderId?: string
  moved: boolean
}

/**
 * Common provider interface implemented by HotmailClient and GmailClient.
 *
 * Each provider handles authentication, inbox fetching, folder/label management,
 * email organization, spam cleanup, and correction detection (when a user manually
 * moves an email to a different folder, indicating a classification mistake).
 */
export interface EmailProvider {
  authenticate(): Promise<boolean>
  fetchInbox(sinceHours: number): Promise<EmailMessage[]>
  listFolders(): Promise<EmailFolder[]>
  setupFolders(categories: string[]): Promise<Map<string, string>>  // category -> folderId
  moveEmail(messageId: string, folderId: string): Promise<boolean>
  cleanupSpam(maxAgeDays: number): Promise<number>
  detectCorrections(folderMap: Map<string, string>): Promise<Array<{messageId: string, oldCategory: string, newCategory: string}>>
}
