/**
 * Images ride inside the message over the live connection instead of a separate HTTP upload.
 * The upload sat at 0% forever for some connections (mint succeeded, no bytes ever reached the
 * server), which blocked the whole send; the inline path has no such second channel to fail.
 */
export const uploadImagesBeforeSend = (): boolean => false;
