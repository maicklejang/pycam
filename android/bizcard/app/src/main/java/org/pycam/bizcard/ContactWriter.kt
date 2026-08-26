package org.pycam.bizcard

import android.content.ContentProviderOperation
import android.content.ContentResolver
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds.Email
import android.provider.ContactsContract.CommonDataKinds.Note
import android.provider.ContactsContract.CommonDataKinds.Organization
import android.provider.ContactsContract.CommonDataKinds.Phone
import android.provider.ContactsContract.CommonDataKinds.Photo
import android.provider.ContactsContract.CommonDataKinds.StructuredName
import android.provider.ContactsContract.CommonDataKinds.StructuredPostal
import android.provider.ContactsContract.CommonDataKinds.Website
import android.provider.ContactsContract.Data
import android.provider.ContactsContract.PhoneLookup
import android.provider.ContactsContract.RawContacts
import androidx.core.content.ContextCompat

/** 추출한 명함 정보를 기기 주소록에 새로 넣거나 기존 연락처에 합친다. */
object ContactWriter {

    /** [created] 가 false 면 기존 연락처를 갱신했다는 뜻이다. */
    data class Result(val created: Boolean, val addedFields: Int, val contactId: Long)

    fun hasWritePermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, android.Manifest.permission.WRITE_CONTACTS) ==
            PackageManager.PERMISSION_GRANTED

    fun hasReadPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, android.Manifest.permission.READ_CONTACTS) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * 휴대폰/전화/이메일이 일치하는 연락처가 있으면 비어 있는 항목만 채워 넣고,
     * 없으면 새 연락처를 만든다. 명함 사진은 연락처 사진이 없을 때만 넣는다.
     */
    fun saveOrUpdate(context: Context, card: BizCard, photo: ByteArray?): Result {
        val resolver = context.contentResolver
        val existingRawContactId = if (hasReadPermission(context)) findRawContactId(resolver, card) else null

        return if (existingRawContactId == null) {
            insertNew(context, card, photo)
        } else {
            update(context, existingRawContactId, card, photo)
        }
    }

    // -------------------------------------------------------------- 신규 등록

    private fun insertNew(context: Context, card: BizCard, photo: ByteArray?): Result {
        val ops = ArrayList<ContentProviderOperation>()
        ops += ContentProviderOperation.newInsert(RawContacts.CONTENT_URI)
            .withValue(RawContacts.ACCOUNT_TYPE, null)
            .withValue(RawContacts.ACCOUNT_NAME, null)
            .build()

        var added = 0
        fun insert(mimeType: String, build: ContentProviderOperation.Builder.() -> Unit) {
            ops += ContentProviderOperation.newInsert(Data.CONTENT_URI)
                .withValueBackReference(Data.RAW_CONTACT_ID, 0)
                .withValue(Data.MIMETYPE, mimeType)
                .apply(build)
                .build()
            added++
        }

        insert(StructuredName.CONTENT_ITEM_TYPE) {
            withValue(StructuredName.DISPLAY_NAME, card.displayName)
        }
        if (card.company.isNotBlank() || card.title.isNotBlank() || card.department.isNotBlank()) {
            insert(Organization.CONTENT_ITEM_TYPE) {
                withValue(Organization.TYPE, Organization.TYPE_WORK)
                withValue(Organization.COMPANY, card.company.ifBlank { null })
                withValue(Organization.TITLE, card.title.ifBlank { null })
                withValue(Organization.DEPARTMENT, card.department.ifBlank { null })
            }
        }
        if (card.mobile.isNotBlank()) insert(Phone.CONTENT_ITEM_TYPE) {
            withValue(Phone.NUMBER, card.mobile); withValue(Phone.TYPE, Phone.TYPE_MOBILE)
        }
        if (card.phone.isNotBlank()) insert(Phone.CONTENT_ITEM_TYPE) {
            withValue(Phone.NUMBER, card.phone); withValue(Phone.TYPE, Phone.TYPE_WORK)
        }
        if (card.fax.isNotBlank()) insert(Phone.CONTENT_ITEM_TYPE) {
            withValue(Phone.NUMBER, card.fax); withValue(Phone.TYPE, Phone.TYPE_FAX_WORK)
        }
        if (card.email.isNotBlank()) insert(Email.CONTENT_ITEM_TYPE) {
            withValue(Email.ADDRESS, card.email); withValue(Email.TYPE, Email.TYPE_WORK)
        }
        if (card.website.isNotBlank()) insert(Website.CONTENT_ITEM_TYPE) {
            withValue(Website.URL, card.website); withValue(Website.TYPE, Website.TYPE_WORK)
        }
        if (card.address.isNotBlank()) insert(StructuredPostal.CONTENT_ITEM_TYPE) {
            withValue(StructuredPostal.FORMATTED_ADDRESS, card.address)
            withValue(StructuredPostal.TYPE, StructuredPostal.TYPE_WORK)
        }
        if (card.note.isNotBlank()) insert(Note.CONTENT_ITEM_TYPE) {
            withValue(Note.NOTE, card.note)
        }
        if (photo != null) insert(Photo.CONTENT_ITEM_TYPE) {
            withValue(Photo.PHOTO, photo)
        }

        val results = context.contentResolver.applyBatch(ContactsContract.AUTHORITY, ops)
        val rawContactId = results.firstOrNull()?.uri?.lastPathSegment?.toLongOrNull() ?: -1L
        return Result(created = true, addedFields = added, contactId = rawContactId)
    }

    // -------------------------------------------------------------- 기존 갱신

    private fun update(context: Context, rawContactId: Long, card: BizCard, photo: ByteArray?): Result {
        val resolver = context.contentResolver
        val existing = readExistingData(resolver, rawContactId)
        val ops = ArrayList<ContentProviderOperation>()
        var added = 0

        fun insert(mimeType: String, build: ContentProviderOperation.Builder.() -> Unit) {
            ops += ContentProviderOperation.newInsert(Data.CONTENT_URI)
                .withValue(Data.RAW_CONTACT_ID, rawContactId)
                .withValue(Data.MIMETYPE, mimeType)
                .apply(build)
                .build()
            added++
        }

        val knownPhones = existing.phones.map { digitsOf(it) }.toSet()
        fun addPhone(number: String, type: Int) {
            if (number.isNotBlank() && digitsOf(number) !in knownPhones) {
                insert(Phone.CONTENT_ITEM_TYPE) {
                    withValue(Phone.NUMBER, number); withValue(Phone.TYPE, type)
                }
            }
        }

        addPhone(card.mobile, Phone.TYPE_MOBILE)
        addPhone(card.phone, Phone.TYPE_WORK)
        addPhone(card.fax, Phone.TYPE_FAX_WORK)

        if (card.email.isNotBlank() && existing.emails.none { it.equals(card.email, ignoreCase = true) }) {
            insert(Email.CONTENT_ITEM_TYPE) {
                withValue(Email.ADDRESS, card.email); withValue(Email.TYPE, Email.TYPE_WORK)
            }
        }
        if (card.website.isNotBlank() && existing.websites.none { it.equals(card.website, ignoreCase = true) }) {
            insert(Website.CONTENT_ITEM_TYPE) {
                withValue(Website.URL, card.website); withValue(Website.TYPE, Website.TYPE_WORK)
            }
        }
        if (card.address.isNotBlank() && !existing.hasPostal) {
            insert(StructuredPostal.CONTENT_ITEM_TYPE) {
                withValue(StructuredPostal.FORMATTED_ADDRESS, card.address)
                withValue(StructuredPostal.TYPE, StructuredPostal.TYPE_WORK)
            }
        }
        if (!existing.hasOrganization &&
            (card.company.isNotBlank() || card.title.isNotBlank() || card.department.isNotBlank())
        ) {
            insert(Organization.CONTENT_ITEM_TYPE) {
                withValue(Organization.TYPE, Organization.TYPE_WORK)
                withValue(Organization.COMPANY, card.company.ifBlank { null })
                withValue(Organization.TITLE, card.title.ifBlank { null })
                withValue(Organization.DEPARTMENT, card.department.ifBlank { null })
            }
        }
        if (!existing.hasName && card.name.isNotBlank()) {
            insert(StructuredName.CONTENT_ITEM_TYPE) {
                withValue(StructuredName.DISPLAY_NAME, card.name)
            }
        }
        // 사용자가 이미 지정해 둔 프로필 사진은 덮어쓰지 않는다.
        if (photo != null && !existing.hasPhoto) {
            insert(Photo.CONTENT_ITEM_TYPE) { withValue(Photo.PHOTO, photo) }
        }

        if (ops.isNotEmpty()) {
            resolver.applyBatch(ContactsContract.AUTHORITY, ops)
        }
        return Result(created = false, addedFields = added, contactId = rawContactId)
    }

    // -------------------------------------------------------------- 조회 도우미

    private class ExistingData(
        val phones: List<String>,
        val emails: List<String>,
        val websites: List<String>,
        val hasPostal: Boolean,
        val hasOrganization: Boolean,
        val hasName: Boolean,
        val hasPhoto: Boolean
    )

    private fun readExistingData(resolver: ContentResolver, rawContactId: Long): ExistingData {
        val phones = ArrayList<String>()
        val emails = ArrayList<String>()
        val websites = ArrayList<String>()
        var hasPostal = false
        var hasOrganization = false
        var hasName = false
        var hasPhoto = false

        resolver.query(
            Data.CONTENT_URI,
            arrayOf(Data.MIMETYPE, Data.DATA1),
            "${Data.RAW_CONTACT_ID} = ?",
            arrayOf(rawContactId.toString()),
            null
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                val mimeType = cursor.getString(0) ?: continue
                val value = cursor.getString(1).orEmpty()
                when (mimeType) {
                    Phone.CONTENT_ITEM_TYPE -> if (value.isNotBlank()) phones += value
                    Email.CONTENT_ITEM_TYPE -> if (value.isNotBlank()) emails += value
                    Website.CONTENT_ITEM_TYPE -> if (value.isNotBlank()) websites += value
                    StructuredPostal.CONTENT_ITEM_TYPE -> hasPostal = true
                    Organization.CONTENT_ITEM_TYPE -> hasOrganization = true
                    StructuredName.CONTENT_ITEM_TYPE -> hasName = hasName || value.isNotBlank()
                    Photo.CONTENT_ITEM_TYPE -> hasPhoto = true
                }
            }
        }
        return ExistingData(phones, emails, websites, hasPostal, hasOrganization, hasName, hasPhoto)
    }

    /** 명함의 번호/이메일과 일치하는 연락처의 raw contact id 를 찾는다. */
    private fun findRawContactId(resolver: ContentResolver, card: BizCard): Long? {
        val contactId = listOf(card.mobile, card.phone)
            .filter { it.isNotBlank() }
            .firstNotNullOfOrNull { lookupByPhone(resolver, it) }
            ?: card.email.takeIf { it.isNotBlank() }?.let { lookupByEmail(resolver, it) }
            ?: return null

        resolver.query(
            RawContacts.CONTENT_URI,
            arrayOf(RawContacts._ID),
            "${RawContacts.CONTACT_ID} = ? AND ${RawContacts.DELETED} = 0",
            arrayOf(contactId.toString()),
            null
        )?.use { cursor ->
            if (cursor.moveToFirst()) return cursor.getLong(0)
        }
        return null
    }

    private fun lookupByPhone(resolver: ContentResolver, number: String): Long? {
        val uri = Uri.withAppendedPath(PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
        return resolver.query(uri, arrayOf(PhoneLookup.CONTACT_ID), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getLong(0) else null
        }
    }

    private fun lookupByEmail(resolver: ContentResolver, email: String): Long? {
        val uri = Uri.withAppendedPath(Email.CONTENT_FILTER_URI, Uri.encode(email))
        return resolver.query(uri, arrayOf(Email.CONTACT_ID), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getLong(0) else null
        }
    }

    private fun digitsOf(value: String): String {
        val digits = value.filter { it.isDigit() }
        // 국가번호 표기 차이를 흡수하기 위해 뒤 9자리로 비교한다.
        return if (digits.length > 9) digits.takeLast(9) else digits
    }
}
