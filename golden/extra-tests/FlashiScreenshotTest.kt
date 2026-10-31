// SPDX-License-Identifier: GPL-3.0-or-later
// Based on AnkiDroid's DeckPickerScreenshotTest and ReviewerScreenshotTest.
package com.ichi2.anki

import android.view.View
import android.content.Intent
import anki.decks.SetDeckCollapsedRequest
import androidx.core.content.edit
import androidx.core.view.GravityCompat
import com.ichi2.anki.common.preferences.sharedPrefs
import com.ichi2.anki.common.time.MockTime
import com.ichi2.anki.common.time.TimeManager
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Before
import org.junit.Test
import org.robolectric.RuntimeEnvironment
import java.io.File
import java.time.Instant

class FlashiScreenshotTest : ScreenshotTest() {
    override fun getCollectionStorageMode() = CollectionStorageMode.IN_MEMORY_WITH_MEDIA

    private val fixture: JSONObject by lazy {
        JSONObject(requireNotNull(javaClass.getResourceAsStream("/flashi/golden-fixture.json")).bufferedReader().readText())
    }

    @Before
    fun flashiSetup() {
        TimeManager.resetWith(MockTime(Instant.parse(fixture.getString("now")).toEpochMilli()))
        setPhoneQualifiers()
        targetContext.sharedPrefs().edit {
            putBoolean("showDeckTitle", false)
            putBoolean("showETA", false)
            putBoolean("backupPromptDisabled", true)
            putBoolean("newReviewerOptions", false)
        }
    }

    private fun loadFixture() {
        val decks = fixture.getJSONArray("decks")
        for (i in 0 until decks.length()) {
            val id = addDeck(decks.getString(i))
            col.decks.setCollapsed(id, collapsed = !fixture.getBoolean("expanded"), SetDeckCollapsedRequest.Scope.REVIEWER)
        }
        val notes = fixture.getJSONArray("notes")
        for (i in 0 until notes.length()) {
            val entry = notes.getJSONObject(i)
            val deckId = col.decks.id(entry.getString("deck"))
            col.decks.select(deckId)
            val fields = entry.getJSONArray("fields")
            val note = addNoteUsingNoteTypeName(entry.getString("notetype"), *Array(fields.length()) { fields.getString(it) })
            val card = note.firstCard()
            col.db.execute("update cards set id=?, due=?, did=? where id=?", entry.getLong("cardId"), i + 1, deckId, card.id)
        }
        col.decks.select(1L)
    }

    private fun frame(name: String, card: View? = null) {
        advanceRobolectricLooper()
        captureScreen(name)
        val metrics = targetContext.resources.displayMetrics
        val json = JSONObject().put("density", metrics.density.toDouble()).put("qualifiers", RuntimeEnvironment.getQualifiers())
        if (card != null) {
            val xy = IntArray(2)
            card.getLocationOnScreen(xy)
            val density = metrics.density
            json.put("cardMask", JSONArray(listOf(xy[0] / density, xy[1] / density, card.width / density, card.height / density)))
        }
        File("build/outputs/roborazzi/FlashiScreenshotTest/$name.json").writeText(json.toString(2))
    }

    @Test fun empty() = withDeckPicker(deckCount = 0) { frame("empty") }
    @Test fun fab() = withDeckPicker(deckCount = 0) {
        it.floatingActionMenu.showFloatingActionMenu()
        frame("fab")
    }
    @Test fun decks() {
        loadFixture()
        withDeckPicker(deckCount = 0) { frame("decks") }
    }
    @Test fun drawer() {
        loadFixture()
        withDeckPicker(deckCount = 0) {
            it.drawerLayout.openDrawer(GravityCompat.START, false)
            frame("drawer")
        }
    }
    private fun reviewer(name: String, answer: Boolean = false, cloze: Boolean = false, overflow: Boolean = false) {
        loadFixture()
        col.decks.select(col.decks.id(if (cloze) "Languages::Cloze" else "Languages::French"))
        check(col.sched.newCount() == if (cloze) 1 else 2) { "Fixture cards must be in the requested study deck" }
        val reviewer = ReviewerTest.startReviewer(this)
        advanceRobolectricLooper()
        if (answer) reviewer.displayCardAnswer()
        if (overflow) reviewer.openOptionsMenu()
        frame(name, reviewer.findViewById(R.id.flashcard))
    }
    @Test fun question() = reviewer("question")
    @Test fun answer() = reviewer("answer", answer = true)
    @Test fun clozeQuestion() = reviewer("cloze-question", cloze = true)
    @Test fun clozeAnswer() = reviewer("cloze-answer", answer = true, cloze = true)
    @Test fun overflow() = reviewer("overflow", overflow = true)
    @Test fun congrats() {
        loadFixture()
        col.decks.select(col.decks.id("Finished"))
        startActivityNormallyOpenCollectionWithIntent(StudyOptionsActivity::class.java, Intent())
        frame("congrats")
    }
}
