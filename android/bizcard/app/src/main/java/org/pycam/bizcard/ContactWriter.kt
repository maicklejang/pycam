package org.pycam.bizcard

import android.content.ContentProviderOperation
import android.content.ContentResolver
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds.Email
import android.provider.ContactsContract.CommonDataKinds.GroupMembership
import android.provider.ContactsContract.CommonDataKinds.Note
import android.provider.ContactsContract.CommonDataKinds.Organization
import android.provider.ContactsContract.CommonDataKinds.Phone
import android.provider.ContactsContract.CommonDataKinds.Photo
import android.provider.ContactsContract.CommonDataKinds.StructuredName
import android.provider.ContactsContract.CommonDataKinds.StructuredPostal
import android.provider.ContactsContract.CommonDataKinds.Website
import android.provider.ContactsContract.Data
import android.provider.ContactsContract.Groups
import android.provider.ContactsContract.PhoneLookup
import android.provider.ContactsContract.RawContacts
import androidx.core.content.ContextCompat

/** 추출한 명함 정보를 기기 주소록에 새로 넣거나 기존 연락처에 합친다. */
object ContactWriter {

    /** [created] 가 false 면 기존 연락처를 갱신했다는 뜻이다. */
    data class Result(
        val created: Boolean,
        val addedFields: Int,
        val contactId: Long,
        /** 실제로 적용된 그룹. 계정이 달라 넣지 못한 그룹은 빠진다. */
        val appliedGroupIds: Set<Long> = emptySet()
    )

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
    fun saveOrUpdate(
        context: Context,
        card: BizCard,
        photo: ByteArray?,
        groups: List<ContactGroup> = emptyList()
    ): Result {
        val resolver = context.contentResolver
        val existingRawContactId = if (hasReadPermission(context)) findRawContactId(resolver, card) else null

        return if (existingRawContactId == null) {
            insertNew(context, card, photo, groups)
        } else {
            update(context, existingRawContactId, card, photo, groups)
        }
    }

    // -------------------------------------------------------------- 그룹 조회

    /**
     * 사용자에게 보여줄 수 있는 연락처 그룹. 자동 그룹(즐겨찾기 등)과 삭제된 그룹은 뺀다.
     * 읽기 권한이 없으면 빈 목록이다.
     */
    fun loadGroups(context: Context): List<ContactGroup> {
        if (!hasReadPermission(context)) return emptyList()

        val groups = ArrayList<ContactGroup>()
        val projection = arrayOf(
            Groups._ID,
            Groups.TITLE,
            Groups.ACCOUNT_NAME,
            Groups.ACCOUNT_TYPE,
            Groups.SUMMARY_COUNT
        )
        val selection = "${Groups.DELETED} = 0 AND ${Groups.AUTO_ADD} = 0 AND ${Groups.FAVORITES} = 0"

        try {
            context.contentResolver.query(
                Groups.CONTENT_SUMMARY_URI,
                projection,
                selection,
                null,
                "${Groups.TITLE} ASC"
            )?.use { cursor ->
                while (cursor.moveToNext()) {
                    groups += ContactGroup(
                        id = cursor.getLong(0),
                        title = cursor.getString(1).orEmpty().trim(),
                        accountName = cursor.getString(2).orEmpty(),
                        accountType = cursor.getString(3).orEmpty(),
                        memberCount = if (cursor.isNull(4)) 0 else cursor.getInt(4)
                    )
                }
            }
        } catch (e: Exception) {
            // 제조사에 따라 일부 열이 없을 수 있다. 그룹 선택은 부가 기능이라 조용히 넘어간다.
            return emptyList()
        }
        return ContactGroups.normalize(groups)
    }

    // -------------------------------------------------------------- 신규 등록

    private fun insertNew(
        context: Context,
        card: BizCard,
        photo: ByteArray?,
        groups: List<ContactGroup>
    ): Result {
        // 그룹에 넣으려면 연락처가 그 그룹과 같은 계정에 있어야 한다.
        // 그래서 고른 그룹 중 첫 번째의 계정에 연락처를 만들고, 그 계정의 그룹만 적용한다.
        val usable = ContactGroups.sameAccount(groups)
        val account = usable.firstOrNull()

        val ops = ArrayList<ContentProviderOperation>()
        ops += ContentProviderOperation.newInsert(RawContacts.CONTENT_URI)
            .withValue(RawContacts.ACCOUNT_TYPE, account?.accountType?.ifBlank { null })
            .withValue(RawContacts.ACCOUNT_NAME, account?.accountName?.ifBlank { null })
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
        usable.map { it.id }.distinct().forEach { groupId ->
            insert(GroupMembership.CONTENT_ITEM_TYPE) {
                withValue(GroupMembership.GROUP_ROW_ID, groupId)
            }
        }

        val results = context.contentResolver.applyBatch(ContactsContract.AUTHORITY, ops)
        val rawContactId = results.firstOrNull()?.uri?.lastPathSegment?.toLongOrNull() ?: -1L
        return Result(
            created = true,
            addedFields = added,
            contactId = rawContactId,
            appliedGroupIds = usable.map { it.id }.toSet()
        )
    }

    // -------------------------------------------------------------- 기존 갱신

    private fun update(
        context: Context,
        rawContactId: Long,
        card: BizCard,
        photo: ByteArray?,
        groups: List<ContactGroup>
    ): Result {
        val resolver = context.contentResolver
        val existing = readExistingData(resolver, rawContactId)
        // 이미 있는 연락처는 계정을 옮길 수 없다. 같은 계정의 그룹만 더할 수 있다.
        val account = readAccount(resolver, rawContactId)
        val usable = ContactGroups.inAccount(groups, account?.first, account?.second)
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
        // 이미 속해 있는 그룹은 건드리지 않고, 새로 고른 그룹만 더한다.
        usable.map { it.id }.distinct().filterNot { it in existing.groupIds }.forEach { groupId ->
            insert(GroupMembership.CONTENT_ITEM_TYPE) {
                withValue(GroupMembership.GROUP_ROW_ID, groupId)
            }
        }

        if (ops.isNotEmpty()) {
            resolver.applyBatch(ContactsContract.AUTHORITY, ops)
        }
        return Result(
            created = false,
            addedFields = added,
            contactId = rawContactId,
            appliedGroupIds = usable.map { it.id }.toSet()
        )
    }

    // -------------------------------------------------------------- 조회 도우미

    private class ExistingData(
        val phones: List<String>,
        val emails: List<String>,
        val websites: List<String>,
        val hasPostal: Boolean,
        val hasOrganization: Boolean,
        val hasName: Boolean,
        val hasPhoto: Boolean,
        val groupIds: Set<Long>
    )

    private fun readExistingData(resolver: ContentResolver, rawContactId: Long): ExistingData {
        val phones = ArrayList<String>()
        val emails = ArrayList<String>()
        val websites = ArrayList<String>()
        var hasPostal = false
        var hasOrganization = false
        var hasName = false
        var hasPhoto = false
        val groupIds = HashSet<Long>()

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
                    GroupMembership.CONTENT_ITEM_TYPE -> value.toLongOrNull()?.let { groupIds += it }
                }
            }
        }
        return ExistingData(
            phones, emails, websites, hasPostal, hasOrganization, hasName, hasPhoto, groupIds
        )
    }

    /** raw contact 가 속한 계정 이름과 종류. 알 수 없으면 null. */
    private fun readAccount(resolver: ContentResolver, rawContactId: Long): Pair<String?, String?>? {
        resolver.query(
            RawContacts.CONTENT_URI,
            arrayOf(RawContacts.ACCOUNT_NAME, RawContacts.ACCOUNT_TYPE),
            "${RawContacts._ID} = ?",
            arrayOf(rawContactId.toString()),
            null
        )?.use { cursor ->
            if (cursor.moveToFirst()) return cursor.getString(0) to cursor.getString(1)
        }
        return null
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
