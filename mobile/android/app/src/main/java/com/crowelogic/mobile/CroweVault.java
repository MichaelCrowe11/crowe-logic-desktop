package com.crowelogic.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Device-bound storage for the token-bearing config record. */
@CapacitorPlugin(name = "CroweVault")
public class CroweVault extends Plugin {
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "com.crowelogic.mobile.vault.v1";
    private static final String PREFS = "com.crowelogic.mobile.vault";
    private static final String CONFIG = "config";
    private static final String CIPHER_SUFFIX = ".ciphertext";
    private static final String IV_SUFFIX = ".iv";
    private static final byte[] AAD = "CroweVault:config:v1".getBytes(StandardCharsets.UTF_8);

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private String acceptedKey(PluginCall call) {
        String key = call.getString("key");
        if (!CONFIG.equals(key)) {
            call.reject("unsupported vault key");
            return null;
        }
        return key;
    }

    private KeyStore keyStore() throws Exception {
        KeyStore store = KeyStore.getInstance(ANDROID_KEYSTORE);
        store.load(null);
        return store;
    }

    private SecretKey existingKey() throws Exception {
        return (SecretKey) keyStore().getKey(KEY_ALIAS, null);
    }

    private SecretKey encryptionKey() throws Exception {
        SecretKey existing = existingKey();
        if (existing != null) return existing;

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }

    private void clear(String key) {
        prefs().edit().remove(key + CIPHER_SUFFIX).remove(key + IV_SUFFIX).commit();
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = acceptedKey(call);
        if (key == null) return;

        String encodedCiphertext = prefs().getString(key + CIPHER_SUFFIX, null);
        String encodedIv = prefs().getString(key + IV_SUFFIX, null);
        JSObject result = new JSObject();
        if (encodedCiphertext == null || encodedIv == null) {
            result.put("value", JSONObject.NULL);
            call.resolve(result);
            return;
        }

        try {
            SecretKey secretKey = existingKey();
            // Restored ciphertext has no matching device-bound key. Discard it
            // and require sign-in rather than weakening storage.
            if (secretKey == null) {
                clear(key);
                result.put("value", JSONObject.NULL);
                call.resolve(result);
                return;
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(
                Cipher.DECRYPT_MODE,
                secretKey,
                new GCMParameterSpec(128, Base64.decode(encodedIv, Base64.NO_WRAP))
            );
            cipher.updateAAD(AAD);
            byte[] plaintext = cipher.doFinal(Base64.decode(encodedCiphertext, Base64.NO_WRAP));
            result.put("value", new String(plaintext, StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("secure storage read failed", error);
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = acceptedKey(call);
        if (key == null) return;
        String value = call.getString("value");
        if (value == null) value = "";

        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, encryptionKey());
            cipher.updateAAD(AAD);
            byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            boolean saved = prefs().edit()
                .putString(key + CIPHER_SUFFIX, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                .putString(key + IV_SUFFIX, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .commit();
            if (!saved) {
                call.reject("secure storage write failed");
                return;
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("secure storage write failed", error);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = acceptedKey(call);
        if (key == null) return;
        clear(key);
        call.resolve();
    }

    // The iOS Share Extension uses this method. Android has no corresponding
    // extension, but keeping the same bridge surface makes platform checks safe.
    @PluginMethod
    public void takeShared(PluginCall call) {
        JSObject result = new JSObject();
        result.put("value", JSONObject.NULL);
        call.resolve(result);
    }
}
